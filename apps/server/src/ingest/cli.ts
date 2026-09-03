// 수동 실행 진입점: pnpm ingest:transcripts
import { pool } from '../db/index.js'
import { ingestTranscripts } from './transcripts.js'

try {
  const r = await ingestTranscripts()
  console.log(`files=${r.files} turns+${r.turns} skills+${r.skills} in ${r.durationMs}ms`)
} finally {
  // 스크립트는 pool을 닫아야 프로세스가 끝난다. 서버는 닫지 않는다.
  await pool.end()
}
