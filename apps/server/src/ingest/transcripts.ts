// Claude Code transcript(~/.claude/projects/<cwd-slug>/<session>.jsonl)를 읽어
// sessions / turns / skill_invocations에 넣는다.
//
// 실행: pnpm ingest:transcripts
// 여러 번 돌려도 안전하다. 키가 원본 ID라 이미 있는 행은 DB가 거절하고,
// 우리는 그 거절을 에러가 아니라 "건너뜀"으로 처리한다(onConflictDoNothing).

import { createReadStream } from 'node:fs'
import { glob } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { db, pool } from '../db/index.js'
import { sessions, turns, skillInvocations } from '../db/schema.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// transcript 한 줄. 필요한 필드만 적었다. 나머지는 무시된다.
type Line = {
  type: string
  uuid?: string
  sessionId?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      output_tokens: number
    }
    content?: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>
  }
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
        inputTokens: m.usage.input_tokens,
        cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
        outputTokens: m.usage.output_tokens,
      })
    }

    for (const block of m.content ?? []) {
      if (block.type !== 'tool_use' || block.name !== 'Skill' || !block.id) continue
      const input = block.input ?? {}
      skills.push({
        id: block.id,
        sessionId: line.sessionId,
        repo: session?.repo ?? null,
        ts,
        skill: String(input.skill ?? ''),
        args: String(input.args ?? ''),
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

async function main() {
  const started = Date.now()
  let files = 0
  const total = { turns: 0, skills: 0 }

  for await (const path of glob(join(PROJECTS_DIR, '*', '*.jsonl'))) {
    const r = await ingestFile(path)
    files++
    total.turns += r.turns
    total.skills += r.skills
  }

  console.log(
    `files=${files} turns+${total.turns} skills+${total.skills} in ${Date.now() - started}ms`,
  )
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
