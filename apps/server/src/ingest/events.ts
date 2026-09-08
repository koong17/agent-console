// ~/.claude/harness-events.jsonl 을 읽어 gate_events 에 넣는다.
//
// 이 파일에는 type=skill 줄도 있지만 넣지 않는다. 스킬 호출은 transcript에서
// tool_use id와 함께 이미 들어오고, 훅 줄에는 그 id가 없어 같은 호출을 구분할 수 없다.
// 훅의 skill 줄은 transcript가 30일 뒤 지워졌을 때를 위한 예비 기록으로만 둔다.
//
// 파일은 매번 처음부터 읽는다. 크기가 작고(하루 수십 줄), (세션, 시각, 스킬)
// 유니크 인덱스가 재삽입을 걸러준다. 커지면 마지막 읽은 오프셋을 기억하는 방식으로 바꾼다.

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { db } from '../db/index.js'
import { gateEvents } from '../db/schema.js'

const EVENTS_PATH = join(homedir(), '.claude', 'harness-events.jsonl')

type EventLine = {
  ts: number
  type: 'skill' | 'gate'
  session_id: string
  cwd?: string
  skill: string
  outcome?: 'nudged' | 'throttled'
}

export async function ingestEvents(): Promise<{ gates: number }> {
  const rows: Array<typeof gateEvents.$inferInsert> = []

  let rl
  try {
    rl = createInterface({ input: createReadStream(EVENTS_PATH), crlfDelay: Infinity })
    for await (const raw of rl) {
      let e: EventLine
      try {
        e = JSON.parse(raw)
      } catch {
        continue
      }
      if (e.type !== 'gate' || !e.outcome) continue
      rows.push({
        sessionId: e.session_id,
        repo: e.cwd ? basename(e.cwd) : null,
        ts: new Date(e.ts * 1000),
        triggerSkill: e.skill,
        outcome: e.outcome,
      })
    }
  } catch (err) {
    // 파일이 아직 없으면(훅이 한 번도 안 울림) 넣을 게 없는 것이지 실패가 아니다.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { gates: 0 }
    throw err
  }

  if (rows.length === 0) return { gates: 0 }
  const inserted = await db
    .insert(gateEvents)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: gateEvents.id })
  return { gates: inserted.length }
}
