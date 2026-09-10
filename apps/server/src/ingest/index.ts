import type { IngestStats } from '../db/schema.js'
import { ingestTranscripts, KNOWN_TYPES, type TranscriptSummary } from './transcripts.js'
import { ingestEvents, type EventsSummary } from './events.js'

// 두 소스가 각자 stats 를 돌려주므로 교차 타입(&)으로 합치면 이름이 부딪힌다.
// 삽입 개수만 펼치고 카운터는 소스별로 stats 안에 나눠 담는다.
export type IngestSummary = Omit<TranscriptSummary, 'stats'> &
  Omit<EventsSummary, 'stats'> & { durationMs: number; stats: IngestStats }

// 모든 소스를 순서대로 읽는다. transcript가 먼저인 이유: gate 준수 판정이
// skill_invocations(transcript 출처)를 보기 때문에 같은 실행 안에서 둘이 맞아야 한다.
export async function ingestAll(): Promise<IngestSummary> {
  const started = Date.now()
  const { stats: transcripts, ...t } = await ingestTranscripts()
  const { stats: events, ...e } = await ingestEvents()
  return { ...t, ...e, durationMs: Date.now() - started, stats: { transcripts, events } }
}

// 설명 안 되는 탈락의 합. 평소 0이어야 하는 숫자라 임계값이 필요 없다.
// 예상된 탈락(synthetic, skillLines)은 일부러 뺐다 — 0이 아닌 게 정상이라
// 합에 넣으면 "0이면 정상"이라는 성질이 깨진다.
export function unexplained(s: IngestStats): number {
  return (
    s.transcripts.badJson +
    s.transcripts.filesEmpty +
    s.transcripts.unusable +
    s.transcripts.unknownTypeLines +
    s.events.badJson +
    s.events.unknownType +
    s.events.incomplete
  )
}

// 경보가 울렸을 때 "무엇이" 처음 보는 모양인지 이름으로 알려준다.
// 숫자만 보여주면 화면에서 DB로 넘어가야 원인을 알 수 있다.
// KNOWN_TYPES 가 서버에만 있으므로 판정도 서버에서 한다.
export function unknownTypes(s: IngestStats): string[] {
  return Object.keys(s.transcripts.typeCounts ?? {}).filter((t) => !KNOWN_TYPES.has(t))
}
