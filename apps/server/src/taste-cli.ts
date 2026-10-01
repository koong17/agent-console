// 수동 실행 진입점: pnpm taste. 에이전트 수정이 기준 브랜치에 얼마나 남았는지 다시 잰다.
import { pool } from './db/index.js'
import { measureSurvival } from './taste.js'
import { measureCommits } from './taste-blame.js'

try {
  const r = await measureSurvival()
  console.log(`edits=${r.edits} measured=${r.measured} repos=${r.repos}`)
  const c = await measureCommits()
  console.log(`commits=${c.commits} repos=${c.repos}`)
} finally {
  await pool.end()
}
