// suah-brain/evals/results/*.json 을 eval_runs / eval_results 에 넣는다.
//
// 파일 하나 = 실행 하나 = 트랜잭션 하나. 파일 이름이 키라 이미 넣은 실행은 건너뛴다.
// 결과 파일은 한 번 쓰이면 안 바뀐다(run-evals.mjs 가 새 이름으로만 쓴다). 그래서
// transcript 처럼 "다시 읽어 더 큰 값으로 고치기"가 필요 없고 onConflictDoNothing 으로 충분하다.
//
// 파일 형식은 세 번 바뀌었다(2026-09-30 전수 조사, 230개): baseline 키가 없던 초기 4개,
// holdout 키가 없던 47개, 둘 다 있는 179개. 없는 키는 false 로 읽는다 — 그 모드가 생기기 전이다.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from '../db/index.js'
import { evalResults, evalRuns } from '../db/schema.js'
import { BRAIN_DIR } from '../brain.js'

const RESULTS_DIR = join(BRAIN_DIR, 'evals', 'results')

type ResultFile = {
  ranAt: string
  senseUpdated?: string
  model: string
  judgeModel: string
  baseline?: boolean
  holdout?: boolean
  total: number
  passed: number
  costUsd?: number
  results: Array<{ id: string; rules?: string[]; pass: boolean; reason?: string; response?: string }>
}

export type EvalsSummary = { evalRuns: number; badEvalFiles: number }

export async function ingestEvals(): Promise<EvalsSummary> {
  let files: string[]
  try {
    files = (await readdir(RESULTS_DIR)).filter((f) => f.endsWith('.json'))
  } catch (err) {
    // 브레인 레포가 없거나 평가를 한 번도 안 돌렸다. 넣을 게 없는 것이지 실패가 아니다.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { evalRuns: 0, badEvalFiles: 0 }
    throw err
  }
  const known = new Set((await db.select({ file: evalRuns.file }).from(evalRuns)).map((r) => r.file))

  let inserted = 0
  let bad = 0
  for (const file of files) {
    if (known.has(file)) continue
    let j: ResultFile
    try {
      j = JSON.parse(await readFile(join(RESULTS_DIR, file), 'utf8'))
    } catch {
      // 쓰는 도중의 파일이거나 깨진 파일. 다음 실행이 다시 본다(known 에 안 들어갔으므로).
      bad++
      continue
    }
    // known 은 빠른 길일 뿐 보장이 아니다. 서버의 스케줄러와 CLI 가 동시에 돌면 둘 다 "아직 없음"을
    // 보고 같은 파일을 넣으려 한다(2026-09-30 실제로 CLI 가 기본 키 충돌로 죽었다). 그래서 넣기 자체를
    // 확인으로 쓴다 — 충돌하면 아무것도 안 넣고, returning 이 비면 다른 쪽이 먼저 넣은 것이다.
    const won = await db.transaction(async (tx) => {
      const run = await tx.insert(evalRuns).values({
        file,
        ranAt: new Date(j.ranAt),
        senseUpdated: j.senseUpdated ?? null,
        model: j.model,
        judgeModel: j.judgeModel,
        mode: j.baseline ? 'baseline' : j.holdout ? 'holdout' : 'full',
        total: j.total,
        passed: j.passed,
        costUsd: j.costUsd === undefined ? null : String(j.costUsd),
      })
        .onConflictDoNothing()
        .returning({ file: evalRuns.file })
      if (run.length === 0) return false
      if (j.results.length)
        await tx
          .insert(evalResults)
          .values(
            j.results.map((r) => ({
              runFile: file,
              caseId: r.id,
              pass: r.pass,
              rules: r.rules ?? [],
              reason: r.reason ?? '',
              response: r.response ?? null,
            })),
          )
          .onConflictDoNothing()
      return true
    })
    if (won) inserted++
  }
  return { evalRuns: inserted, badEvalFiles: bad }
}
