// ~/.claude/harness-events.jsonl 을 읽어 gate_events 와 decisions 에 넣는다.
//
// 이 파일에는 type=skill 줄도 있지만 넣지 않는다. 스킬 호출은 transcript에서
// tool_use id와 함께 이미 들어오고, 훅 줄에는 그 id가 없어 같은 호출을 구분할 수 없다.
// 훅의 skill 줄은 transcript가 30일 뒤 지워졌을 때를 위한 예비 기록으로만 둔다.
//
// 파일은 매번 처음부터 읽는다. 크기가 작고(하루 수십 줄), 표마다 있는 자연 키
// 유니크 인덱스가 재삽입을 걸러준다. 커지면 마지막 읽은 오프셋을 기억하는 방식으로 바꾼다.
//
// 한 번 읽으면서 두 표의 행을 동시에 모은다. 줄 타입별로 파일을 두 번 읽는 것보다 단순하고,
// 두 표는 서로 참조하지 않아 넣는 순서도 상관없다.

import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { db } from '../db/index.js'
import { readLines } from './lines.js'
import { gateEvents, decisions, type EventStats } from '../db/schema.js'

const EVENTS_PATH = join(homedir(), '.claude', 'harness-events.jsonl')

// 훅 셋(log-skill, suah-judge-gate, log-decision)이 남기는 줄의 합집합.
// type으로 갈라 읽으므로 타입별 필드는 optional로 둔다.
type EventLine = {
  ts: number
  type: 'skill' | 'gate' | 'decision' | 'memory-deny' | 'slack-voice-gate' | 'vr-reminder'
  session_id: string
  cwd?: string
  // skill, gate
  skill?: string
  outcome?: 'nudged' | 'throttled'
  // decision (scripts/hooks/log-decision.sh 출력 형식)
  header?: string
  question?: string
  options?: string[]
  recommended?: string | null
  chosen?: string | null
  agreed?: boolean | null
  raw_response?: unknown
  // 2026-09-30 부터 남는다. 그 전 줄에는 없다.
  multi_select?: boolean
  // 2026-09-30 부터. 복수 선택은 추천이 여럿일 수 있다.
  recommended_all?: string[]
}

export type EventsSummary = { gates: number; decisions: number; stats: EventStats }

export async function ingestEvents(): Promise<EventsSummary> {
  const gateRows: Array<typeof gateEvents.$inferInsert> = []
  const decisionRows: Array<typeof decisions.$inferInsert> = []
  const stats: EventStats = {
    lines: 0,
    badJson: 0,
    skillLines: 0,
    unknownType: 0,
    incomplete: 0,
    memoryDeny: 0,
    slackVoiceGate: 0,
    vrReminder: 0,
  }

  try {
    // 훅이 남기는 decision 줄에는 질문 원문이 그대로 들어간다. 거기 U+2028 이
    // 섞이면 transcript 와 같은 이유로 줄이 잘린다. 같은 리더를 쓴다.
    for await (const raw of readLines(EVENTS_PATH)) {
      stats.lines++
      let e: EventLine
      try {
        e = JSON.parse(raw)
      } catch {
        stats.badJson++
        continue
      }
      // 설계상 안 넣는 줄. 예상된 탈락이라 먼저 걸러 incomplete 와 섞이지 않게 한다.
      if (e.type === 'skill') {
        stats.skillLines++
        continue
      }
      // 모든 타입이 공통으로 쓰는 필드. 없으면 행을 만들 수 없다.
      // 예전에는 이 검사가 없어서 ts 가 없는 줄이 Invalid Date 로 DB까지 내려가
      // 실행 전체를 실패시켰다. 이제 그 줄 하나만 빼고 카운터에 남긴다.
      if (!e.ts || !e.session_id) {
        stats.incomplete++
        continue
      }
      const common = {
        sessionId: e.session_id,
        repo: e.cwd ? basename(e.cwd) : null,
        ts: new Date(e.ts * 1000),
      }
      if (e.type === 'gate') {
        if (e.skill && e.outcome) gateRows.push({ ...common, triggerSkill: e.skill, outcome: e.outcome })
        else stats.incomplete++
      } else if (e.type === 'decision') {
        if (e.question)
          decisionRows.push({
            ...common,
            header: e.header ?? '',
            question: e.question,
            options: e.options ?? [],
            recommended: e.recommended ?? null,
            chosen: e.chosen ?? null,
            agreed: e.agreed ?? null,
            rawResponse: e.raw_response ?? null,
            multiSelect: e.multi_select ?? null,
            recommendedAll: e.recommended_all ?? null,
          })
        else stats.incomplete++
      } else if (e.type === 'memory-deny') {
        // memory-type-gate.sh 가 교정·선호를 프로젝트 메모리에 쓰려는 시도를 막은 기록. 건수만 본다.
        stats.memoryDeny++
      } else if (e.type === 'slack-voice-gate') {
        // 남의 채널에 수아 이름으로 글을 보내기 전 말투 확인 훅(2026-09-30, suah-brain 쪽에서 추가).
        // 적재는 건수만. 판정(asked/allowed/denied)별 집계가 필요해지면 표를 만든다.
        stats.slackVoiceGate++
      } else if (e.type === 'vr-reminder') {
        // 완료 주장 순간의 검증 규칙 훅(scripts/hooks/vr-reminder.sh). 지금은 건수만. 판정별(would-block/
        // disclosed/blocked) 비율을 보려면 표가 필요하다 — log 모드로 며칠 쌓은 뒤 정한다.
        stats.vrReminder++
      } else {
        // 훅이 새 type 을 남기기 시작했는데 우리가 아직 안 읽고 있다는 뜻이다.
        stats.unknownType++
      }
    }
  } catch (err) {
    // 파일이 아직 없으면(훅이 한 번도 안 울림) 넣을 게 없는 것이지 실패가 아니다.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { gates: 0, decisions: 0, stats }
    throw err
  }

  // 파일 하나 = 트랜잭션 하나. transcripts.ts 와 같은 단위다.
  //
  // 여기서 트랜잭션이 사는 것과 못 사는 것을 구분해 둔다. gate_events 와 decisions 는
  // 서로 참조하지 않으므로, 중간에 죽어도 화면에 보이는 반쪽 상태는 생기지 않는다.
  // 게다가 파일을 매번 처음부터 읽고 키가 자연 키라, 빠진 행은 다음 실행이 알아서 넣는다.
  // 그러니 데이터 정합성만 보면 트랜잭션이 없어도 결국 수렴한다.
  //
  // 그래도 씌우는 이유는 실행 기록 쪽이다. 중간에 죽으면 ingest_runs 는 그 실행을
  // failed 로 적는데, 트랜잭션이 없으면 "failed 인데 절반은 들어간" 행이 남는다.
  // failed = 아무것도 안 들어감 이라는 성질은 transcripts 쪽에 이미 있고, 한쪽만
  // 다르면 나중에 실행 기록을 근거로 뭔가를 판단할 때 그 예외를 기억해야 한다.
  //
  // 값 개수 제한(문장당 파라미터 65535)에는 아직 안 닿는다. decisions 가 열 9개라
  // 약 7천 행이 한계인데 지금 160 행이다. 닿기 전에 이 파일 머리 주석대로
  // "마지막 읽은 오프셋 기억" 방식으로 먼저 바뀔 것이다.
  return db.transaction(async (tx) => {
    // insert(...).values([])는 drizzle이 에러를 내므로 빈 배열은 건너뛴다.
    const gates =
      gateRows.length === 0
        ? 0
        : (
            await tx
              .insert(gateEvents)
              .values(gateRows)
              .onConflictDoNothing()
              .returning({ id: gateEvents.id })
          ).length
    const decided =
      decisionRows.length === 0
        ? 0
        : (
            await tx
              .insert(decisions)
              .values(decisionRows)
              .onConflictDoNothing()
              .returning({ id: decisions.id })
          ).length
    return { gates, decisions: decided, stats }
  })
}
