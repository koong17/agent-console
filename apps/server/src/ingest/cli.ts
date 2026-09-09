// 수동 실행 진입점: pnpm ingest
import { pool } from '../db/index.js'
import { ingestAll } from './index.js'

try {
  const r = await ingestAll()
  console.log(`files=${r.files} turns+${r.turns} skills+${r.skills} gates+${r.gates} decisions+${r.decisions} in ${r.durationMs}ms`)
} finally {
  // 스크립트는 pool을 닫아야 프로세스가 끝난다. 서버는 닫지 않는다.
  await pool.end()
}
