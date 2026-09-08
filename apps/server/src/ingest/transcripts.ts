// Claude Code transcript(~/.claude/projects/<cwd-slug>/<session>.jsonl)를 읽어
// sessions / turns / skill_invocations에 넣는다.
//
// 진입점은 둘이다. CLI(pnpm ingest, cli.ts)와 서버 안 스케줄러(scheduler.ts).
// 여러 번 돌려도 안전하다. 키가 원본 ID라 이미 있는 행은 DB가 거절하고,
// 우리는 그 거절을 에러가 아니라 "건너뜀"으로 처리한다(onConflictDoNothing).

import { createReadStream } from 'node:fs'
import { glob } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { db } from '../db/index.js'
import { sessions, turns, skillInvocations } from '../db/schema.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// transcript 한 줄. 필요한 필드만 적었다. 나머지는 무시된다.
// Claude Code 내장 슬래시 명령. 사용자 메시지의 <command-name>에 나오지만 스킬이 아니다.
// 이 목록에 없는 이름만 skill_invocations 에 넣는다. 새 내장 명령이 생기면 여기 추가.
const BUILTIN_COMMANDS = new Set([
  'clear',
  'model',
  'exit',
  'quit',
  'copy',
  'login',
  'logout',
  'plugin',
  'plugins',
  'insights',
  'resume',
  'help',
  'config',
  'settings',
  'status',
  'cost',
  'compact',
  'memory',
  'init',
  'doctor',
  'bug',
  'review',
  'permissions',
  'mcp',
  'agents',
  'hooks',
  'vim',
  'terminal-setup',
  'export',
  'rename',
  'tasks',
  'artifacts',
  'fast',
  'loop',
  'workflows',
  'context',
  'usage',
  'upgrade',
  'release-notes',
  'add-dir',
  'ide',
  'install-github-app',
  'install-slack-app',
  'pr-comments',
  'diff',
  'rewind',
  'theme',
  'keybindings',
])

type Line = {
  type: string
  uuid?: string
  isSidechain?: boolean
  sessionId?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  message?: {
    id?: string
    role?: string
    model?: string
    usage?: {
      input_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
      output_tokens: number
    }
    content?: MessageContent
  }
}

type MessageContent =
  string | Array<{ type: string; id?: string; name?: string; text?: string; input?: Record<string, unknown> }>

// 사용자 메시지 본문에서 "/스킬이름 인자" 입력을 찾는다. Claude Code는 이를
//   <command-name>/feature-plan</command-name> ... <command-args>TMS-1234</command-args>
// 형태로 기록한다. 한 메시지에 여러 개일 수 있어 배열로 돌려준다.
function parseCommands(content: MessageContent | undefined) {
  const texts: string[] =
    typeof content === 'string' ? [content] : (content ?? []).map((c) => c.text ?? '').filter(Boolean)
  const out: Array<{ skill: string; args: string }> = []
  for (const t of texts) {
    const names = [...t.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)].map((m) => m[1]!.trim())
    const args = [...t.matchAll(/<command-args>([^<]*)<\/command-args>/g)].map((m) => m[1]!.trim())
    names.forEach((name, i) => {
      if (!BUILTIN_COMMANDS.has(name)) out.push({ skill: name, args: args[i] ?? '' })
    })
  }
  return out
}

type Parsed = {
  session: typeof sessions.$inferInsert
  turns: Array<typeof turns.$inferInsert>
  skills: Array<typeof skillInvocations.$inferInsert>
}

// 파일 하나를 끝까지 읽어 넣을 행들을 메모리에 모은다.
// 264MB짜리 폴더를 통째로 읽지 않고 파일 단위로 처리하는 이유다.
async function parseFile(path: string): Promise<Parsed | null> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })

  let session: typeof sessions.$inferInsert | null = null
  // 같은 message.id가 여러 줄에 나오므로 Map으로 한 번만 담는다.
  const turnMap = new Map<string, typeof turns.$inferInsert>()
  const skills: Parsed['skills'] = []

  for await (const raw of rl) {
    let line: Line
    try {
      line = JSON.parse(raw)
    } catch {
      continue // 잘린 줄(강제 종료 등)은 건너뛴다
    }
    if (!line.sessionId || !line.timestamp) continue
    const ts = new Date(line.timestamp)

    if (!session && line.cwd) {
      session = {
        id: line.sessionId,
        cwd: line.cwd,
        repo: basename(line.cwd),
        gitBranch: line.gitBranch ?? null,
        cliVersion: line.version ?? null,
        startedAt: ts,
        lastSeenAt: ts,
      }
    } else if (session) {
      if (ts < session.startedAt) session.startedAt = ts
      if (ts > session.lastSeenAt) session.lastSeenAt = ts
      if (line.gitBranch) session.gitBranch = line.gitBranch
    }

    // 사용자가 직접 친 "/스킬" 입력. 도구 호출이 아니라서 아래 tool_use 루프에는 안 잡힌다.
    if (line.type === 'user' && line.message && line.uuid) {
      parseCommands(line.message.content).forEach((c, i) => {
        skills.push({
          // 사용자 메시지엔 tool_use id가 없다. 줄 uuid + 순번으로 고유 키를 만든다.
          id: `cmd:${line.uuid}:${i}`,
          sessionId: line.sessionId!,
          repo: session?.repo ?? null,
          ts,
          skill: c.skill,
          args: c.args,
          source: 'command',
        })
      })
      continue
    }

    if (line.type !== 'assistant' || !line.message) continue
    const m = line.message
    // '<synthetic>'은 API 에러 등을 Claude Code가 만들어 넣은 가짜 응답. 토큰 0.
    if (!m.id || !m.usage || !m.model || m.model === '<synthetic>') continue

    if (!turnMap.has(m.id)) {
      turnMap.set(m.id, {
        id: m.id,
        sessionId: line.sessionId,
        ts,
        model: m.model,
        sidechain: line.isSidechain === true,
        inputTokens: m.usage.input_tokens,
        cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
        cacheCreation1hTokens: m.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        outputTokens: m.usage.output_tokens,
      })
    }

    for (const block of typeof m.content === 'string' ? [] : (m.content ?? [])) {
      if (block.type !== 'tool_use' || block.name !== 'Skill' || !block.id) continue
      const input = block.input ?? {}
      skills.push({
        id: block.id,
        sessionId: line.sessionId,
        repo: session?.repo ?? null,
        ts,
        skill: String(input.skill ?? ''),
        args: String(input.args ?? ''),
        source: 'tool',
      })
    }
  }

  if (!session) return null
  return { session, turns: [...turnMap.values()], skills }
}

// INSERT 한 문장에 넣을 행 수. Postgres는 문장당 파라미터 65535개 제한이 있어서
// 열 8개 × 500행 = 4000개로 넉넉히 아래에 둔다.
const CHUNK = 500

function chunks<T>(arr: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK))
  return out
}

async function ingestFile(path: string) {
  const parsed = await parseFile(path)
  if (!parsed) return { turns: 0, skills: 0 }

  // 파일 하나 = 트랜잭션 하나. 중간에 죽으면 그 파일은 하나도 안 들어간 상태로 남아
  // 다음 실행이 처음부터 다시 넣는다. 세션만 들어가고 turn은 없는 반쪽 상태를 막는다.
  return db.transaction(async (tx) => {
    // 세션은 "있으면 갱신". 다시 읽을 때 last_seen_at이 늘어나야 한다.
    await tx
      .insert(sessions)
      .values(parsed.session)
      .onConflictDoUpdate({
        target: sessions.id,
        set: { lastSeenAt: parsed.session.lastSeenAt, gitBranch: parsed.session.gitBranch },
      })

    let insertedTurns = 0
    for (const batch of chunks(parsed.turns)) {
      // returning으로 실제 들어간 행만 돌려받는다. 두 번째 실행에서 0이 나와야 정상.
      const rows = await tx.insert(turns).values(batch).onConflictDoNothing().returning({ id: turns.id })
      insertedTurns += rows.length
    }

    let insertedSkills = 0
    for (const batch of chunks(parsed.skills)) {
      const rows = await tx
        .insert(skillInvocations)
        .values(batch)
        .onConflictDoNothing()
        .returning({ id: skillInvocations.id })
      insertedSkills += rows.length
    }

    return { turns: insertedTurns, skills: insertedSkills }
  })
}

export type TranscriptSummary = { files: number; turns: number; skills: number }

export async function ingestTranscripts(): Promise<TranscriptSummary> {
  const total = { files: 0, turns: 0, skills: 0 }

  // '**' 로 서브에이전트 파일까지 훑는다. 위치:
  //   <proj>/<session>.jsonl                                  메인 대화
  //   <proj>/<session>/subagents/agent-*.jsonl                Agent 도구 서브에이전트
  //   <proj>/<session>/subagents/workflows/<wf>/agent-*.jsonl Workflow 도구 안의 에이전트
  // 서브에이전트 줄의 sessionId는 부모와 같아서 같은 세션에 turns가 붙는다.
  for await (const path of glob(join(PROJECTS_DIR, '**', '*.jsonl'))) {
    const r = await ingestFile(path)
    total.files++
    total.turns += r.turns
    total.skills += r.skills
  }

  return total
}
