// 작업 종류 'pair-drill': 실제 에이전트 보고 글 하나를 한 관점에서만 다른 두 글로 다시 쓴다.
//
// 관점과 그 값은 고정 목록이다(DIMENSIONS). 작업마다 관점 하나, 값 두 개를 고른다. 같은 원문으로
// 여러 관점을 만들지 않는다 — 한 원문이 여러 번 나오면 수아가 내용을 기억해 문체가 아니라 익숙함으로 고른다.
//
// 실패 지점: 모델이 문체만 바꾸라는 말을 어기고 내용을 빼거나 더할 수 있다. 그러면 수아는 내용으로 고른다.
// 프롬프트로 막고, 화면에서 원문을 펼쳐 볼 수 있게 한다.

import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { drillPairs } from '../db/schema.js'
import { enqueue, type Handler } from './runner.js'

export const KIND = 'pair-drill'
const DEFAULT_PAIRS = 30
const MIN_CHARS = 300
const MAX_CHARS = 1500

// 관점 → 값 → 그 값으로 쓰라는 지시. 값의 이름이 점수표에 그대로 나온다.
export const DIMENSIONS: Record<string, Record<string, string>> = {
  length: {
    terse: 'As short as possible: only the conclusion and the facts needed to act. Fragments allowed.',
    balanced: 'Moderate length: the conclusion, then a few supporting points in full sentences.',
    detailed: 'Thorough: the conclusion, the reasoning, and the relevant details, each explained.',
  },
  order: {
    'conclusion-first': 'Open with the conclusion or the decision, then the reasons.',
    'context-first': 'Open with the background and what was found, and arrive at the conclusion at the end.',
  },
  register: {
    plain: 'Plain words a non-specialist understands; define any technical term inline.',
    technical: 'Dense technical vocabulary, assuming an expert reader; no definitions.',
  },
}

type Input = { messageId: string; text: string; dimension: string; styleA: string; styleB: string }
type Output = { textA: string; textB: string }

export const pairDrillHandler: Handler<Input, Output> = {
  kind: KIND,
  model: 'sonnet',
  concurrency: 3,
  jsonSchema: {
    type: 'object',
    properties: { textA: { type: 'string' }, textB: { type: 'string' } },
    required: ['textA', 'textB'],
    additionalProperties: false,
  },
  async prompt(input) {
    const d = DIMENSIONS[input.dimension]!
    return {
      system: `Rewrite a message an AI coding agent wrote to its user, twice. Keep the facts, numbers, decisions, and
open questions exactly the same in both; do not add or drop content. Change only the style described for each
version. Write in the original language (Korean stays Korean). Keep code identifiers and file names unchanged.`,
      prompt: [
        `Version A style: ${d[input.styleA]}`,
        `Version B style: ${d[input.styleB]}`,
        '',
        'Original message:',
        input.text,
      ].join('\n'),
    }
  },
  async apply(tx, job, output) {
    const input = job.input as Input
    await tx.insert(drillPairs).values({
      dimension: input.dimension,
      styleA: input.styleA,
      styleB: input.styleB,
      sourceMessageId: input.messageId,
      textA: output.textA.trim(),
      textB: output.textB.trim(),
      jobId: job.id,
    })
  },
}

// 표본: 메인 대화의 에이전트 글 가운데 적당한 길이의 보고. md5 순서라 다시 돌려도 같은 글부터 나온다.
// 관점은 번갈아 돌리고, 값 쌍도 돌린다(length 는 셋 중 둘). A/B 자리는 번갈아 바꿔 위치 편향을 줄인다.
export async function enqueuePairs(limit = DEFAULT_PAIRS) {
  const rows = (
    await db.execute<{ id: string; text: string }>(sql`
      select m.id, m.text from messages m
      where m.kind = 'assistant' and not m.sidechain and length(m.text) between ${MIN_CHARS} and ${MAX_CHARS}
        and not exists (select 1 from drill_pairs p where p.source_message_id = m.id)
        and not exists (select 1 from llm_jobs j where j.kind = ${KIND} and j.subject = m.id)
      order by md5(m.id)
      limit ${limit}
    `)
  ).rows
  const dims = Object.keys(DIMENSIONS)
  const items = rows.map((r, i) => {
    const dimension = dims[i % dims.length]!
    const values = Object.keys(DIMENSIONS[dimension]!)
    const pairs = values.flatMap((a, x) => values.slice(x + 1).map((b) => [a, b] as const))
    const [p, q] = pairs[Math.floor(i / dims.length) % pairs.length]!
    const [styleA, styleB] = i % 2 === 0 ? [p, q] : [q, p]
    return { subject: r.id, input: { messageId: r.id, text: r.text, dimension, styleA, styleB } }
  })
  return enqueue(KIND, items)
}
