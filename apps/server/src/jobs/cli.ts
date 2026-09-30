// 수동 실행 진입점: pnpm jobs <종류> [--limit N] [--retry-failed]
//
// 넣고(enqueue) 비울 때까지(drain) 돌린다. 서버 안에서 자동으로 돌리지 않는 이유:
// 결정이 새로 쌓일 때마다 돈이 드는 호출이 저절로 나가게 되는데, 그 기준(얼마나 자주, 얼마까지)을
// 아직 정하지 않았다. 정하기 전까지는 사람이 돌린다.
import { pool } from '../db/index.js'
import { drain, recoverStale, retryFailed } from './runner.js'
import { KIND as QUESTION_KIND, enqueueUnclassified, kindSummary, questionKindHandler } from './question-kind.js'

const [kind, ...rest] = process.argv.slice(2)
const limitAt = rest.indexOf('--limit')
const limit = limitAt >= 0 ? Number(rest[limitAt + 1]) : undefined

try {
  if (kind !== QUESTION_KIND) {
    console.error(`알 수 없는 작업 종류: ${kind ?? '(없음)'}. 가능한 값: ${QUESTION_KIND}`)
    process.exitCode = 2
  } else {
    const recovered = await recoverStale()
    const retried = rest.includes('--retry-failed') ? await retryFailed(kind) : 0
    const queued = await enqueueUnclassified(limit)
    const s = await drain(questionKindHandler, { limit })
    console.log(
      `recovered=${recovered} retried=${retried} queued+${queued} done=${s.done} failed=${s.failed} cost=$${s.costUsd.toFixed(4)}`,
    )
    for (const k of await kindSummary()) console.log(`${String(k.n).padStart(4)}  ${k.kind}`)
  }
} finally {
  await pool.end()
}
