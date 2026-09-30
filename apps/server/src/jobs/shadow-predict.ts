// 작업 종류 'shadow-predict': 과거 결정 하나를 그 시점의 브레인으로 블라인드 재예측한다.
//
// 블라인드의 뜻: 모델은 선택지 라벨만 본다. "(추천)" 같은 표시는 지운다. 수아가 고른 답도,
// 그 질문 직전 에이전트가 늘어놓은 설명도 안 보여준다. 설명에는 대개 추천 이유가 들어 있어서
// 보여주면 닻이 다시 내린다. 대가로 "위 답 반영 후" 처럼 앞 대화에 기대는 질문은 맞히기 어렵다.
// 그런 질문의 오답은 브레인의 한계가 아니라 이 방식의 한계라서, 분류(질문 종류)와 함께 봐야 한다.
//
// 대상: 단일 선택이고, 수아의 답이 선택지 중 하나인 결정. 복수 선택과 직접 입력(Other)은
// "맞았다"를 한 줄로 정할 수 없어서 뺀다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { asc, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { decisions, llmJobs, shadowPredictions } from '../db/schema.js'
import { BRAIN_DIR } from '../brain.js'
import { enqueue, type Handler } from './runner.js'

const execFileAsync = promisify(execFile)

export const KIND = 'shadow-predict'

// 추천 표시. 훅(scripts/hooks/log-decision.sh)이 추천을 알아보는 패턴과 같다.
// 셋째 복사본이라는 걸 안다 — 훅은 셸, 웹은 표시용이라 한 곳으로 모을 수단이 없다.
// 패턴을 바꾸면 세 곳을 같이 바꾼다.
const MARKER = /\s*\((Recommended|추천|권장)\)\s*$/
export const strip = (label: string) => label.replace(MARKER, '').trim()

type Input = {
  decisionId: number
  header: string
  question: string
  options: string[] // 표시를 지운 라벨
  chosen: string // 표시를 지운 수아의 답. 프롬프트에는 안 들어간다(apply 가 채점에만 쓴다)
  brainCommit: string
}
type Output = { choice: string; confidence: number; reason: string }

// 결정 시각 직전의 브레인 커밋. 이 커밋의 sense.md 가 그때 에이전트가 따랐던 규칙이다.
export async function commitBefore(ts: Date) {
  const { stdout } = await execFileAsync('git', ['rev-list', '-1', `--before=${ts.toISOString()}`, 'main'], { cwd: BRAIN_DIR })
  return stdout.trim()
}

export async function senseAt(commit: string) {
  const { stdout } = await execFileAsync('git', ['show', `${commit}:identity/sense.md`], {
    cwd: BRAIN_DIR,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

export const shadowPredictHandler: Handler<Input, Output> = {
  kind: KIND,
  // 로드맵이 정한 모델. 판단 문서 전체(30KB)를 읽고 고르는 일이라 작은 모델로 재면
  // 브레인이 아니라 모델의 한계를 재게 된다.
  model: 'opus',
  // 선택지를 enum 으로 묶는다. 목록 밖의 답은 스키마 단계에서 막히고, apply 의 검사는 두 번째 벽이다.
  jsonSchema: (input) => ({
    type: 'object',
    properties: {
      choice: { type: 'string', enum: input.options },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
    },
    required: ['choice', 'confidence', 'reason'],
    additionalProperties: false,
  }),

  async prompt(input) {
    const sense = await senseAt(input.brainCommit)
    return {
      system: [
        'You are predicting what Suah, a frontend engineer, chose when an AI coding agent asked her a question.',
        'You see only the question and its options, not the conversation around it and not the agent\'s recommendation.',
        'The document below is her judgment guide as it stood when she answered. Use it to predict her choice.',
        'Return the option label exactly as given, your probability (0 to 1) that she chose it, and a one-sentence reason in Korean.',
        '',
        '----- identity/sense.md -----',
        sense,
      ].join('\n'),
      prompt: [
        `header: ${input.header || '(none)'}`,
        `question: ${input.question}`,
        'options:',
        ...input.options.map((o) => `- ${o}`),
      ].join('\n'),
    }
  },

  async apply(tx, job, output) {
    const input = job.input as Input
    const predicted = strip(output.choice)
    const confidence = String(Math.min(1, Math.max(0, output.confidence)))
    const correct = predicted === input.chosen
    // 모델이 목록에 없는 라벨을 지어내면 채점할 수 없다. 조용히 오답 처리하지 않고 작업을 실패시킨다 —
    // 오답으로 넣으면 "브레인이 틀림"과 "모델이 형식을 어김"이 한 숫자에 섞인다.
    if (!input.options.includes(predicted)) throw new Error(`선택지에 없는 답: ${output.choice}`)
    await tx
      .insert(shadowPredictions)
      .values({
        decisionId: input.decisionId,
        jobId: job.id,
        brainCommit: input.brainCommit,
        predicted,
        confidence,
        correct,
        reason: output.reason,
      })
      .onConflictDoUpdate({
        target: shadowPredictions.decisionId,
        set: { jobId: job.id, brainCommit: input.brainCommit, predicted, confidence, correct, reason: output.reason },
      })
  },
}

// 채점할 수 있는 결정만 넣는다. 오래된 것부터.
export async function enqueueEligible(limit?: number) {
  const q = db
    .select({
      id: decisions.id,
      ts: decisions.ts,
      header: decisions.header,
      question: decisions.question,
      options: decisions.options,
      chosen: decisions.chosen,
      multiSelect: decisions.multiSelect,
    })
    .from(decisions)
    .where(
      sql`${decisions.chosen} is not null and ${decisions.multiSelect} is false
        and not exists (select 1 from ${llmJobs} where ${llmJobs.kind} = ${KIND} and ${llmJobs.subject} = ${decisions.id}::text)`,
    )
    .orderBy(asc(decisions.ts), asc(decisions.id))
  const rows = await q
  const items: Array<{ subject: string; input: Input }> = []
  for (const r of rows) {
    const options = r.options.map(strip)
    const chosen = strip(r.chosen!)
    if (options.length < 2 || !options.includes(chosen)) continue // Other 직접 입력
    items.push({
      subject: String(r.id),
      input: { decisionId: r.id, header: r.header, question: r.question, options, chosen, brainCommit: await commitBefore(r.ts) },
    })
    if (limit && items.length >= limit) break
  }
  return enqueue(KIND, items)
}
