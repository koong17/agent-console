import type { IngestStats, StoredIngestStats } from '../db/schema.js'
import { ingestTranscripts, KNOWN_TYPES, type TranscriptSummary } from './transcripts.js'
import { ingestEvents, type EventsSummary } from './events.js'
import { ingestEvals, type EvalsSummary } from './evals.js'

// 두 소스가 각자 stats 를 돌려주므로 교차 타입(&)으로 합치면 이름이 부딪힌다.
// 삽입 개수만 펼치고 카운터는 소스별로 stats 안에 나눠 담는다.
export type IngestSummary = Omit<TranscriptSummary, 'stats'> &
  Omit<EventsSummary, 'stats'> &
  EvalsSummary & { durationMs: number; stats: IngestStats }

// 모든 소스를 순서대로 읽는다. transcript가 먼저인 이유: gate 준수 판정이
// skill_invocations(transcript 출처)를 보기 때문에 같은 실행 안에서 둘이 맞아야 한다.
export async function ingestAll(): Promise<IngestSummary> {
  const started = Date.now()
  const { stats: transcripts, ...t } = await ingestTranscripts()
  const { stats: events, ...e } = await ingestEvents()
  // 브레인 평가 결과. 위 둘과 독립이라 순서는 상관없다. 실행 기록(ingest_runs)에는 아직 열이 없다 —
  // 결과 파일은 몇 시간에 한 번 생기므로 CLI 출력으로 충분하다.
  const v = await ingestEvals()
  return { ...t, ...e, ...v, durationMs: Date.now() - started, stats: { transcripts, events } }
}

// 설명 안 되는 탈락의 합. 평소 0이어야 하는 숫자라 임계값이 필요 없다.
// 예상된 탈락(synthetic, skillLines)은 일부러 뺐다 — 0이 아닌 게 정상이라
// 합에 넣으면 "0이면 정상"이라는 성질이 깨진다.
export function unexplained(s: StoredIngestStats): number {
  // 옛 실행 행에는 나중에 생긴 카운터가 없다. ?? 0 으로 읽어 합계가 NaN 이 되지 않게 한다.
  return (
    s.transcripts.badJson +
    s.transcripts.filesEmpty +
    s.transcripts.unusable +
    s.transcripts.unknownTypeLines +
    (s.transcripts.toolResultsUnmatched ?? 0) +
    s.events.badJson +
    s.events.unknownType +
    s.events.incomplete
  )
}

// 경보가 울렸을 때 "무엇이" 처음 보는 모양인지 이름으로 알려준다.
// 숫자만 보여주면 화면에서 DB로 넘어가야 원인을 알 수 있다.
// KNOWN_TYPES 가 서버에만 있으므로 판정도 서버에서 한다.
export function unknownTypes(s: StoredIngestStats): string[] {
  return Object.keys(s.transcripts.typeCounts ?? {}).filter((t) => !KNOWN_TYPES.has(t))
}
