import { ingestTranscripts, type TranscriptSummary } from './transcripts.js'
import { ingestEvents, type EventsSummary } from './events.js'

export type IngestSummary = TranscriptSummary & EventsSummary & { durationMs: number }

// 모든 소스를 순서대로 읽는다. transcript가 먼저인 이유: gate 준수 판정이
// skill_invocations(transcript 출처)를 보기 때문에 같은 실행 안에서 둘이 맞아야 한다.
export async function ingestAll(): Promise<IngestSummary> {
  const started = Date.now()
  const t = await ingestTranscripts()
  const e = await ingestEvents()
  return { ...t, ...e, durationMs: Date.now() - started }
}
