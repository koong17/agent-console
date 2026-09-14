// Claude Code transcript(~/.claude/projects/<cwd-slug>/<session>.jsonl)를 읽어
// sessions / turns / skill_invocations에 넣는다.
//
// 진입점은 둘이다. CLI(pnpm ingest, cli.ts)와 서버 안 스케줄러(scheduler.ts).
// 여러 번 돌려도 안전하다. 키가 원본 ID라서 이미 있는 행은 DB가 걸러낸다.
// sessions/skill_invocations 는 건너뛰고(onConflictDoNothing), turns 는 토큰 열만
// 더 큰 값으로 갱신한다(onConflictDoUpdate + greatest). 같은 파일을 다시 읽으면
// 결과가 같은 값으로 수렴한다 — "아무것도 안 바꿈"이 아니라 "같은 상태로 수렴".

import { glob } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { readLines } from './lines.js'
import { sessions, turns, skillInvocations, type TranscriptStats } from '../db/schema.js'

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

// 2026-09-10 기준 실제 트랜스크립트에 나타나는 type 전부(22종). 여기 없는 type 이
// 나오면 unknownTypeLines 로 센다. 그게 "상류가 형식을 바꿨다"의 신호다.
//
// 대가를 알고 쓴다: Claude Code 가 무해한 새 type 을 추가하기만 해도 경보가 울린다.
// 오탐이지만 받아들인다 — "처음 보는 줄 모양이 나왔다"는 어차피 알고 싶은 사실이고,
// 고치는 비용은 여기에 한 줄 추가다. BUILTIN_COMMANDS 와 같은 종류의 유지보수 목록.
export const KNOWN_TYPES = new Set([
  'assistant',
  'attachment',
  'user',
  'mode',
  'last-prompt',
  'bridge-session',
  'system',
  'ai-title',
  'atis-latch',
  'file-history-snapshot',
  'queue-operation',
  'permission-mode',
  'pr-link',
  'custom-title',
  'file-history-delta',
  'frame-link',
  'cost-state',
  'agent-name',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
])

// 트랜스크립트가 아닌데 glob 이 같이 집는 파일. 대화가 아니라 워크플로 실행 기록이라
// 세션도 턴도 없다. 빼지 않으면 filesEmpty 가 영원히 1이고, 그러면
// "설명 안 되는 탈락 = 0" 이라는 기준이 성립하지 않는다.
//
// 이름을 하나만 박아두는 게 위험해 보이지만, 앞으로 다른 비-트랜스크립트 파일이
// 섞여 들어오면 그 파일의 type 들이 unknownTypeLines 로 잡힌다. 목록을 미리
// 완벽하게 만들 필요가 없는 이유다.
const NOT_TRANSCRIPT = new Set(['journal.jsonl'])

// type 이 문자열이 아닌 줄(필드 자체가 사라진 경우)에 쓸 이름. 집계 키로 쓰려면
// 이름이 있어야 하고, 실제 type 과 겹치지 않게 꺾쇠를 붙인다.
const NO_TYPE = '<none>'

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

// 카운터를 0으로 시작한 새 객체. ingestTranscripts 와 테스트가 같은 초기 상태를 쓴다.
// 인라인 리터럴로 두면 카운터를 추가할 때 한쪽만 고치고 다른 쪽은 undefined 로 남는다.
export function emptyTranscriptStats(): TranscriptStats {
  return {
    lines: 0,
    badJson: 0,
    filesEmpty: 0,
    typeCounts: {},
    unknownTypeLines: 0,
    assistantLines: 0,
    synthetic: 0,
    unusable: 0,
  }
}

type Parsed = {
  session: typeof sessions.$inferInsert
  turns: Array<typeof turns.$inferInsert>
  skills: Array<typeof skillInvocations.$inferInsert>
}

// 파일 하나를 끝까지 읽어 넣을 행들을 메모리에 모은다.
// 264MB짜리 폴더를 통째로 읽지 않고 파일 단위로 처리하는 이유다.
//
// stats는 호출자가 넘긴 실행 단위 누적기다. 반환값에 얹지 않고 인자로 받는 이유:
// 카운터는 파일별 결과가 아니라 실행 전체의 합이고, 파일마다 합치는 코드를
// 호출부에 또 쓰고 싶지 않아서다.
export async function parseFile(path: string, stats: TranscriptStats): Promise<Parsed | null> {
  let session: typeof sessions.$inferInsert | null = null
  // 같은 message.id가 여러 줄에 나오므로 Map으로 한 번만 담는다.
  const turnMap = new Map<string, typeof turns.$inferInsert>()
  const skills: Parsed['skills'] = []

  for await (const raw of readLines(path)) {
    stats.lines++
    let line: Line
    try {
      line = JSON.parse(raw)
    } catch {
      stats.badJson++ // 잘린 줄(강제 종료 등)은 건너뛴다
      continue
    }

    // sessionId 검사보다 먼저 센다. sessionId 필드 이름이 바뀌는 경우에도
    // type 집계는 남아야 "줄은 멀쩡히 있었다"를 보여줄 수 있다.
    const type = typeof line.type === 'string' ? line.type : NO_TYPE
    stats.typeCounts[type] = (stats.typeCounts[type] ?? 0) + 1
    if (!KNOWN_TYPES.has(type)) stats.unknownTypeLines++

    // 여기 걸리는 줄은 세지 않는다. summary, file-history-snapshot 처럼 세션 필드가
    // 원래 없는 줄이 정상적으로 많이 섞여 있어서, 세면 신호가 아니라 잡음이 된다.
    // sessionId 이름 자체가 바뀌는 경우는 filesEmpty 가 대신 잡는다.
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
    stats.assistantLines++
    // '<synthetic>'은 API 에러 등을 Claude Code가 만들어 넣은 가짜 응답. 토큰 0.
    // 예상된 탈락이라 unusable 과 따로 센다.
    if (m.model === '<synthetic>') {
      stats.synthetic++
      continue
    }
    // 여기 걸리면 assistant 줄인데 우리가 쓰는 필드가 없다는 뜻이다. 평소 0이어야 한다.
    // 상류가 usage/id 필드 이름을 바꾸면 이 숫자가 assistantLines 와 같아진다.
    if (!m.id || !m.usage || !m.model) {
      stats.unusable++
      continue
    }

    const row = {
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
    }
    const prev = turnMap.get(m.id)
    if (!prev) {
      turnMap.set(m.id, row)
    } else {
      // 같은 응답이 여러 줄에 걸쳐 기록되고, 줄마다 usage 가 같지 않다.
      // Claude Code 는 스트리밍 중간 상태를 먼저 쓰고 완성본을 나중에 쓴다.
      // 그래서 첫 줄을 채택하면 output_tokens 가 미완성 값으로 굳는다 —
      // 2026-09-10 측정: 전체 output 토큰의 22.75%가 이렇게 누락돼 있었다.
      //
      // 마지막 줄 대신 항목별 max 를 쓴다. 실측으로 값이 줄어드는 경우는 0건이라
      // 두 방식의 결과가 같지만, max 는 "완성본이 파일에서 나중"이라는 순서 가정에
      // 기대지 않는다. 이 파일 형식은 우리가 통제하지 않으므로 가정을 줄인다.
      //
      // 토큰만 max 로 합친다. ts/model/sidechain 은 첫 줄 값을 유지한다 —
      // ts 를 마지막 줄로 옮기면 일별 비용 집계의 날짜 경계가 조용히 움직인다.
      prev.inputTokens = Math.max(prev.inputTokens, row.inputTokens)
      prev.cacheReadTokens = Math.max(prev.cacheReadTokens, row.cacheReadTokens)
      prev.cacheCreationTokens = Math.max(prev.cacheCreationTokens, row.cacheCreationTokens)
      // 이 열만 스키마에 default(0)이 있어서 타입이 optional 이다. 값은 항상 채워 넣지만 좁혀준다.
      prev.cacheCreation1hTokens = Math.max(prev.cacheCreation1hTokens ?? 0, row.cacheCreation1hTokens)
      prev.outputTokens = Math.max(prev.outputTokens, row.outputTokens)
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

async function ingestFile(path: string, stats: TranscriptStats) {
  const parsed = await parseFile(path, stats)
  if (!parsed) {
    // 줄은 있는데 세션을 못 만들었다는 건 cwd/sessionId 를 한 줄도 못 읽었다는 뜻이다.
    // 진짜 빈 파일도 여기 걸리므로 0이 아닌 기준선이 있을 수 있다. 급증이 신호다.
    stats.filesEmpty++
    return { turns: 0, turnsUpdated: 0, skills: 0 }
  }

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
    let updatedTurns = 0
    for (const batch of chunks(parsed.turns)) {
      // 예전에는 onConflictDoNothing 이었다. 그러면 한 번 잘못 들어간 토큰 값이
      // 영구히 남는다 — 실제로 output_tokens 미완성 값 5009행이 그렇게 굳어 있었다.
      // 이제 토큰 열만 갱신한다. 나머지 열(ts/model/sidechain)은 안 건드린다.
      //
      // setWhere 가 핵심이다. 이게 없으면 매 실행마다 2만 행을 의미 없이 덮어쓰고,
      // returning 이 그 행을 다 돌려줘서 "turns +N"이 항상 2만이 된다 — 카운터가 거짓말한다.
      // 조건을 "토큰이 하나라도 커질 때"로 두면 정상 실행에서는 갱신이 0건이고,
      // returning 은 새로 들어간 행만 돌려준다. 카운터의 뜻이 유지된다.
      //
      // GREATEST 로 합치는 이유: 한 실행 안에서는 parseFile 이 이미 max 를 냈지만,
      // DB 에 이미 있는 행과 비교하면 이번 값이 더 작을 수도 있다(파일이 잘려 다시 읽히는 경우).
      // 내려가는 갱신을 만들지 않는다.
      const rows = await tx
        .insert(turns)
        .values(batch)
        .onConflictDoUpdate({
          target: turns.id,
          set: {
            inputTokens: sql`greatest(${turns.inputTokens}, excluded.input_tokens)`,
            cacheReadTokens: sql`greatest(${turns.cacheReadTokens}, excluded.cache_read_tokens)`,
            cacheCreationTokens: sql`greatest(${turns.cacheCreationTokens}, excluded.cache_creation_tokens)`,
            cacheCreation1hTokens: sql`greatest(${turns.cacheCreation1hTokens}, excluded.cache_creation_1h_tokens)`,
            outputTokens: sql`greatest(${turns.outputTokens}, excluded.output_tokens)`,
          },
          setWhere: sql`excluded.input_tokens > ${turns.inputTokens}
            or excluded.cache_read_tokens > ${turns.cacheReadTokens}
            or excluded.cache_creation_tokens > ${turns.cacheCreationTokens}
            or excluded.cache_creation_1h_tokens > ${turns.cacheCreation1hTokens}
            or excluded.output_tokens > ${turns.outputTokens}`,
        })
        // xmax=0 이면 이 행은 INSERT 였다. 0이 아니면 UPDATE 다.
        // Postgres 가 행마다 들고 있는 시스템 열이라 별도 조회 없이 둘을 가른다.
        .returning({ id: turns.id, inserted: sql<boolean>`(xmax = 0)` })
      for (const r of rows)
        if (r.inserted) insertedTurns++
        else updatedTurns++
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

    return { turns: insertedTurns, turnsUpdated: updatedTurns, skills: insertedSkills }
  })
}

export type TranscriptSummary = {
  files: number
  turns: number
  // 이미 있던 행의 토큰이 더 큰 값으로 교정된 수. 정상 실행에서는 0이어야 한다.
  turnsUpdated: number
  skills: number
  stats: TranscriptStats
}

export async function ingestTranscripts(): Promise<TranscriptSummary> {
  const total = { files: 0, turns: 0, turnsUpdated: 0, skills: 0 }
  const stats = emptyTranscriptStats()

  // '**' 로 서브에이전트 파일까지 훑는다. 위치:
  //   <proj>/<session>.jsonl                                  메인 대화
  //   <proj>/<session>/subagents/agent-*.jsonl                Agent 도구 서브에이전트
  //   <proj>/<session>/subagents/workflows/<wf>/agent-*.jsonl Workflow 도구 안의 에이전트
  // 서브에이전트 줄의 sessionId는 부모와 같아서 같은 세션에 turns가 붙는다.
  for await (const path of glob(join(PROJECTS_DIR, '**', '*.jsonl'))) {
    if (NOT_TRANSCRIPT.has(basename(path))) continue
    const r = await ingestFile(path, stats)
    total.files++
    total.turns += r.turns
    total.turnsUpdated += r.turnsUpdated
    total.skills += r.skills
  }

  return { ...total, stats }
}
