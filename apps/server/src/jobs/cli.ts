// 수동 실행 진입점: pnpm jobs <종류> [--limit N] [--retry-failed]
//
// 넣고(enqueue) 비울 때까지(drain) 돌린다. 서버 안에서 자동으로 돌리지 않는 이유:
// 결정이 새로 쌓일 때마다 돈이 드는 호출이 저절로 나가게 되는데, 그 기준(얼마나 자주, 얼마까지)을
// 아직 정하지 않았다. 정하기 전까지는 사람이 돌린다.
import { pool } from '../db/index.js'
import { drain, recoverStale, retryFailed, type Handler } from './runner.js'
import * as questionKind from './question-kind.js'
import * as shadowPredict from './shadow-predict.js'
import * as messageIntent from './message-intent.js'
import * as correctionReplay from './correction-replay.js'
import * as answerPolicy from './answer-policy.js'
import * as evalDraft from './eval-draft.js'
import * as draftTheme from './draft-theme.js'
import { exportKinds, KINDS_FILE } from './export-kinds.js'

// 종류마다 handler 와 "넣을 대상 고르기" 하나씩.
const KINDS: Record<string, { handler: Handler<never, never>; enqueue: (limit?: number) => Promise<number> }> = {
  [questionKind.KIND]: { handler: questionKind.questionKindHandler as Handler<never, never>, enqueue: questionKind.enqueueUnclassified },
  [shadowPredict.KIND]: { handler: shadowPredict.shadowPredictHandler as Handler<never, never>, enqueue: shadowPredict.enqueueEligible },
  [messageIntent.KIND]: { handler: messageIntent.messageIntentHandler as Handler<never, never>, enqueue: messageIntent.enqueueUnclassified },
  [correctionReplay.KIND]: { handler: correctionReplay.correctionReplayHandler as Handler<never, never>, enqueue: correctionReplay.enqueueCorrections },
  [answerPolicy.KIND]: { handler: answerPolicy.answerPolicyHandler as Handler<never, never>, enqueue: answerPolicy.enqueueKinds },
  [evalDraft.KIND]: { handler: evalDraft.evalDraftHandler as Handler<never, never>, enqueue: evalDraft.enqueueReplays },
  [draftTheme.KIND]: { handler: draftTheme.draftThemeHandler as Handler<never, never>, enqueue: draftTheme.enqueueThemes },
}

const [kind, ...rest] = process.argv.slice(2)
const limitAt = rest.indexOf('--limit')
const limit = limitAt >= 0 ? Number(rest[limitAt + 1]) : undefined

try {
  const k = kind ? KINDS[kind] : undefined
  if (!k) {
    console.error(`알 수 없는 작업 종류: ${kind ?? '(없음)'}. 가능한 값: ${Object.keys(KINDS).join(', ')}`)
    process.exitCode = 2
  } else {
    const recovered = await recoverStale()
    const retried = rest.includes('--retry-failed') ? await retryFailed(kind!) : 0
    const queued = await k.enqueue(limit)
    const s = await drain(k.handler, { limit })
    console.log(
      `recovered=${recovered} retried=${retried} queued+${queued} done=${s.done} failed=${s.failed} cost=$${s.costUsd.toFixed(4)}`,
    )
    if (kind === questionKind.KIND)
      for (const r of await questionKind.kindSummary()) console.log(`${String(r.n).padStart(4)}  ${r.kind}`)
    // 둘 다 precedents 가 읽는 파일의 재료라 끝나면 다시 쓴다.
    if (kind === questionKind.KIND || kind === answerPolicy.KIND)
      console.log(`exported ${await exportKinds()} → ${KINDS_FILE}`)
  }
} finally {
  await pool.end()
}
