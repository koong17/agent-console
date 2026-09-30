// 작업 종류 'solo-decision': 에이전트 글에서 "묻지 않고 혼자 정한 결정"을 뽑는다.
//
// 대상 글: 메인 대화의 에이전트 글 중, 그 글에 답한 수아 메시지가 교정·방향 전환이 아닌 것.
// 교정이 붙은 글은 이미 교정 되짚기가 본다. 여기는 "아무 일 없이 지나간" 쪽이다.
//
// 전부 돌리지 않고 표본을 뽑는다(pnpm jobs solo-decision --limit N, 기본 300). 표본은 id 의 md5 순서라
// 매번 같은 글이 먼저 뽑힌다 — 다시 돌려도 같은 표본이 이어지고, 무작위처럼 날짜·세션이 섞인다.
//
// 한 번에 BATCH 개 글을 묻는다(message-intent 와 같은 이유: 호출 하나의 고정비가 크다).

import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { soloDecisions } from '../db/schema.js'
import { enqueue, type Handler } from './runner.js'

export const KIND = 'solo-decision'
const BATCH = 10
const TEXT_CHARS = 3000
const DEFAULT_SAMPLE = 300

type Input = { items: Array<{ messageId: string; text: string }> }
type Output = { items: Array<{ id: string; decisions: Array<{ summary: string; alternative: string }> }> }

const SYSTEM = `You read messages an AI coding agent wrote to Suah, its user, and list the judgment calls the agent made
on its own without asking her: a design or scope choice, a default it picked, something it deliberately left out,
a tradeoff it settled. Only calls that another reasonable agent might have made differently.

Not decisions: facts it reported, steps it merely executed as instructed, questions it asked, restating her request.

For each message return up to 3 decisions, most consequential first; an empty list is fine and common.
summary: one Korean sentence, "~로 했다" form, understandable without the message ("테스트 DB 를 별도 DB 로 격리했다").
alternative: one Korean sentence naming the path not taken ("트랜잭션 롤백으로 격리").`

export const soloDecisionHandler: Handler<Input, Output> = {
  kind: KIND,
  model: 'haiku',
  concurrency: 4,
  jsonSchema: (input) => ({
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: input.items.map((i) => i.messageId) },
            decisions: {
              type: 'array',
              maxItems: 3,
              items: {
                type: 'object',
                properties: { summary: { type: 'string' }, alternative: { type: 'string' } },
                required: ['summary', 'alternative'],
                additionalProperties: false,
              },
            },
          },
          required: ['id', 'decisions'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  }),

  async prompt(input) {
    return {
      system: SYSTEM,
      prompt: input.items.map((i) => `=== message ${i.messageId} ===\n${i.text.slice(0, TEXT_CHARS)}`).join('\n\n'),
    }
  },

  async apply(tx, job, output) {
    const input = job.input as Input
    const got = new Map(output.items.map((o) => [o.id, o.decisions]))
    // message-intent 와 같은 규칙: 빠진 글이 있으면 묶음 전체를 실패시킨다. "결정 없음"과 "답에서 빠짐"을
    // 섞으면, 빠진 글은 결정이 없던 것으로 조용히 기록된다.
    const missing = input.items.filter((i) => !got.has(i.messageId))
    if (missing.length) throw new Error(`답에 빠진 글 ${missing.length}건`)
    const rows = input.items.flatMap((i) =>
      got.get(i.messageId)!.slice(0, 3).map((d, idx) => ({
        messageId: i.messageId,
        idx,
        summary: d.summary.trim(),
        alternative: d.alternative.trim(),
        jobId: job.id,
      })),
    )
    // 판정이 이미 있는 결정은 안 덮는다. 다시 뽑아도 수아의 답이 기준이다.
    if (rows.length) await tx.insert(soloDecisions).values(rows).onConflictDoNothing()
  },
}

export async function enqueueSample(limit = DEFAULT_SAMPLE) {
  // 에이전트 글 a 가 있고, a 에 답한 typed 메시지 m 이 있으며, m 의 개입 종류가 교정·방향 전환이 아닌 것.
  const rows = (
    await db.execute<{ id: string; text: string }>(sql`
      select a.id, a.text from messages a
      join messages m on m.reply_to = a.id and m.kind = 'typed'
      join message_intents mi on mi.message_id = m.id
      where a.kind = 'assistant' and not a.sidechain
        and mi.intent not in ('correction', 'redirect')
        and not exists (select 1 from solo_decisions s where s.message_id = a.id)
        and not exists (select 1 from llm_jobs j where j.kind = ${KIND} and j.status in ('queued', 'running', 'done')
          and j.input -> 'items' @> jsonb_build_array(jsonb_build_object('messageId', a.id)))
      group by a.id, a.text
      order by md5(a.id)
      limit ${limit}
    `)
  ).rows
  const batches = []
  for (let i = 0; i < rows.length; i += BATCH) {
    const items = rows.slice(i, i + BATCH).map((r) => ({ messageId: r.id, text: r.text }))
    const subject = createHash('sha1').update(items.map((x) => x.messageId).join('\n')).digest('hex').slice(0, 16)
    batches.push({ subject, input: { items } })
  }
  return enqueue(KIND, batches)
}
