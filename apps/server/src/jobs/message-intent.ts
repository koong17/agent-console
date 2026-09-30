// 작업 종류 'message-intent': 수아가 직접 친 메시지 하나를 개입 종류로 분류한다.
//
// 분류표는 고정이다(스키마의 enum). question-kind 처럼 목록이 자라지 않으므로 메시지끼리
// 서로의 결과에 기대지 않는다 — 그래서 동시에 여러 개를 돌려도 된다(concurrency).
//
// 메시지만 보면 모른다. "아니 그거 말고" 는 앞에서 에이전트가 무슨 말을 했는지 알아야 교정인지
// 안다. 그래서 replyTo 가 가리키는 직전 에이전트 글을 같이 준다. 길면 뒤쪽만 준다 — 에이전트는
// 보통 글 끝에 질문이나 결론을 둔다.
//
// 실패 지점: 직전 글이 없는 메시지(세션 첫 메시지, 연달아 보낸 둘째 메시지)는 맥락 없이 판단한다.
// 첫 메시지는 대개 new-request 라 괜찮지만, 연달아 보낸 둘째가 교정이면 놓칠 수 있다.
//
// 작업 하나 = 메시지 BATCH 개. 처음엔 한 개씩이었는데 한 건에 $0.015 가 들었다. 재 보니 입력이
// 아니라 고정비였다 — claude -p 는 구조화 답을 도구 호출 한 턴으로 받고 thinking 도 켜서, 짧은
// 메시지 하나에도 출력이 600 토큰쯤 나온다(--effort low 도 그대로였다). 묶으면 그 고정비를 나눠 낸다.
// 대가: 한 건이 틀린 형식으로 오면 묶음 전체가 실패하고, 묶음 안에서 앞 메시지가 뒤 판단에 번질 수 있다.

import { createHash } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { llmJobs, messageIntents, messages } from '../db/schema.js'
import { enqueue, type Handler } from './runner.js'

export const KIND = 'message-intent'

const INTENTS = ['correction', 'answer', 'redirect', 'approval', 'new-request', 'other'] as const
type Intent = (typeof INTENTS)[number]

// 프롬프트에 넣는 길이 상한(문자). 대부분의 메시지와 에이전트 글 끝부분이 들어가는 길이다.
// 긴 붙여넣기(로그, 문서)가 비용을 키우지 않게 자른다.
const MESSAGE_CHARS = 2000
const CONTEXT_CHARS = 1500
const BATCH = 20

type Item = { messageId: string; text: string; before: string | null }
type Input = { items: Item[] }
type Output = { items: Array<{ id: string; intent: Intent; confidence: number }> }

const SYSTEM = `You classify messages Suah typed to an AI coding agent. Each message comes with the agent's
text right before it. Classify each message on its own; the messages are unrelated to each other.
Return one item per message id.

Intents:
- correction: says the agent did, said, or assumed something wrong, or restates a rule the agent broke.
  Includes mild forms ("that's not what I meant", "왜 X 안 했어?" when X was expected).
- answer: answers a question the agent asked in its text.
- redirect: changes direction, scope, or priority of the current work without saying the agent was wrong.
- approval: a go-ahead or acknowledgement to continue as proposed ("좋아", "ㅇㅇ", "push 해줘").
- new-request: starts a task unrelated to the agent's previous text, or the first message of a session.
- other: anything else (thanks, chit-chat, a pasted log with no instruction).

If a message does two things, pick the one that tells the agent it was wrong (correction) first,
then redirect, then the rest. Confidence is your probability that the label is right.`

export const messageIntentHandler: Handler<Input, Output> = {
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
            intent: { type: 'string', enum: [...INTENTS] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['id', 'intent', 'confidence'],
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
      prompt: input.items
        .map((i) =>
          [
            `=== message ${i.messageId} ===`,
            'Agent text before:',
            i.before ? i.before.slice(-CONTEXT_CHARS) : '(none — first message or sent right after another message)',
            "Suah's message:",
            i.text.slice(0, MESSAGE_CHARS),
          ].join('\n'),
        )
        .join('\n\n'),
    }
  },

  async apply(tx, job, output) {
    const input = job.input as Input
    // 빠진 메시지가 있으면 묶음 전체를 실패시킨다.
    //
    // 이유는 "나머지를 못 믿어서"다. 스무 개 중 하나를 빠뜨린 답은 모델이 묶음을 놓쳤다는 신호이고,
    // 같은 답 안의 나머지 열아홉도 같은 상태에서 나왔다. 전부 버리고 다시 물으면 비용은 한 묶음어치(약 $0.05)다.
    //
    // 이전 주석은 "일부만 넣으면 빠진 메시지를 다시 넣을 길이 없다"였는데, 틀렸다(2026-09-30 grill 에서 확인).
    // enqueueUnclassified 는 분류가 없고 queued/running 묶음에 없는 메시지를 고르므로, done 묶음에서 빠진
    // 메시지는 다음 실행에 새 묶음으로 들어간다. 일부 저장도 가능한 설계이고, 지금은 신뢰 쪽을 골랐을 뿐이다.
    const got = new Map(output.items.map((o) => [o.id, o]))
    const missing = input.items.filter((i) => !got.has(i.messageId))
    if (missing.length) throw new Error(`답에 빠진 메시지 ${missing.length}건: ${missing.map((m) => m.messageId).join(', ')}`)
    for (const i of input.items) {
      const o = got.get(i.messageId)!
      const confidence = String(Math.min(1, Math.max(0, o.confidence)))
      await tx
        .insert(messageIntents)
        .values({ messageId: i.messageId, jobId: job.id, intent: o.intent, confidence })
        .onConflictDoUpdate({ target: messageIntents.messageId, set: { jobId: job.id, intent: o.intent, confidence } })
    }
  },
}

// 아직 분류가 없는 typed 메시지를 오래된 것부터 BATCH 개씩 묶는다. 직전 에이전트 글은 넣을 때
// 붙여 둔다 — 실행 시점에 다시 찾을 필요가 없고, 입력만 보고도 모델이 무엇을 봤는지 알 수 있다.
//
// 묶음의 키(subject)는 메시지 id 목록의 해시다. 같은 메시지 묶음은 같은 키라 두 번 안 들어가고,
// 실패한 묶음은 --retry-failed 로 같은 작업을 다시 돌린다.
// limit 은 묶음 수가 아니라 메시지 수다.
export async function enqueueUnclassified(limit?: number) {
  const before = db.$with('before').as(db.select({ id: messages.id, text: messages.text }).from(messages))
  const q = db
    .with(before)
    .select({ id: messages.id, text: messages.text, before: before.text })
    .from(messages)
    .leftJoin(before, eq(before.id, messages.replyTo))
    .where(
      sql`${messages.kind} = 'typed' and not exists (select 1 from ${messageIntents} where ${messageIntents.messageId} = ${messages.id})
        and not exists (select 1 from ${llmJobs} where ${llmJobs.kind} = ${KIND} and ${llmJobs.status} in ('queued', 'running')
          and ${llmJobs.input} -> 'items' @> jsonb_build_array(jsonb_build_object('messageId', ${messages.id})))`,
    )
    .orderBy(asc(messages.ts))
  const rows = limit ? await q.limit(limit) : await q
  const batches: Array<{ subject: string; input: Input }> = []
  for (let i = 0; i < rows.length; i += BATCH) {
    const items = rows.slice(i, i + BATCH).map((r) => ({ messageId: r.id, text: r.text, before: r.before }))
    const subject = createHash('sha1').update(items.map((x) => x.messageId).join('\n')).digest('hex').slice(0, 16)
    batches.push({ subject, input: { items } })
  }
  return enqueue(KIND, batches)
}
