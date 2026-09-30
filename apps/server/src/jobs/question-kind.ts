// 작업 종류 'question-kind': 결정(decisions) 하나의 질문이 어느 "질문 종류"인지 정한다.
//
// 종류 목록은 미리 없다. 작업마다 지금까지 생긴 목록을 프롬프트에 넣고, 맞는 게 있으면 그 이름을,
// 없으면 새 이름을 받는다. 그래서 순서대로 한 건씩 돌아야 한다(runner.ts drain 주석).
//
// 선택한 답(chosen)은 넣지 않는다. 종류는 "무엇을 물었나"로 정해야 한다. 답을 보여 주면
// 같은 질문이 답에 따라 다른 종류로 갈릴 수 있고, 뒤에 올 블라인드 재예측이 이 분류를 쓸 때
// 답이 새어 들어간 분류를 쓰게 된다.
//
// 실패 지점: 모델이 기존 종류와 뜻은 같고 이름만 다른 새 종류를 만들 수 있다. 이름을 정확히
// 재사용하라고 지시하고, 목록을 설명과 함께 보여 주는 것으로 줄이지만 막지는 못한다.
// 종류 수가 결정 수에 가깝게 불어나면 그 신호다 — 그러면 목록을 합치는 작업이 따로 필요하다.

import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { decisions, decisionKinds, llmJobs, questionKinds } from '../db/schema.js'
import { enqueue, type Handler } from './runner.js'

export const KIND = 'question-kind'

type Input = { header: string; question: string; options: string[] }
type Output = { kind: string; description: string }

const SYSTEM = `You classify questions that an AI coding agent asked its user, Suah, into kinds.

A kind groups questions where one standing answer policy could apply. Two questions are the same kind
when Suah's reasoning to answer them would be the same, even if the wording, project, or ticket differs.
Name a kind by the decision being made, not by the project topic.

A kind is specific enough that a single standing answer could plausibly apply to every question in it.
"Commit approval" and "whether to split a commit into structural and behavioral parts" are kinds.
"Choosing a path", "how to proceed", or "next step" are not kinds — they describe the form of any
question. Look at what the options actually decide and name that.

The header is a short UI chip the agent chose ("경로", "Approach", "범위"). It is often generic. Do not
name the kind after it.

Rules:
- If an existing kind fits, return its name exactly as listed, character for character.
- Never put a question into an existing kind only because the kind is broad. If the existing kind's
  standing answer would not apply to this question, create a new kind.
- Create a new kind only when no existing kind fits. Prefer reusing a slightly broader kind over creating
  a near-duplicate.
- Kind names are short Korean noun phrases (2 to 6 words). Descriptions are one Korean sentence saying
  what decision the kind covers.
- For an existing kind, return its existing description unchanged.`

export const questionKindHandler: Handler<Input, Output> = {
  kind: KIND,
  model: 'haiku',
  jsonSchema: {
    type: 'object',
    properties: { kind: { type: 'string' }, description: { type: 'string' } },
    required: ['kind', 'description'],
    additionalProperties: false,
  },

  async prompt(input) {
    const kinds = await db
      .select({ name: questionKinds.name, description: questionKinds.description })
      .from(questionKinds)
      .orderBy(asc(questionKinds.createdAt))
    const list = kinds.length ? kinds.map((k) => `- ${k.name}: ${k.description}`).join('\n') : '(none yet)'
    return {
      system: SYSTEM,
      prompt: [
        `Existing kinds:\n${list}`,
        '',
        'Question to classify:',
        `header: ${input.header || '(none)'}`,
        `question: ${input.question}`,
        `options: ${input.options.join(' | ')}`,
      ].join('\n'),
    }
  },

  async apply(tx, job, output) {
    const name = output.kind.trim()
    // 처음 보는 이름이면 종류를 만든다. 이미 있으면 설명을 덮지 않는다 — 첫 설명이 목록의 기준이다.
    await tx
      .insert(questionKinds)
      .values({ name, description: output.description.trim(), createdByJob: job.id })
      .onConflictDoNothing()
    // 다시 분류하면(작업을 지우고 다시 넣으면) 새 결과로 바꾼다.
    await tx
      .insert(decisionKinds)
      .values({ decisionId: Number(job.subject), kind: name, jobId: job.id })
      .onConflictDoUpdate({ target: decisionKinds.decisionId, set: { kind: name, jobId: job.id } })
  },
}

// 아직 작업이 없는 결정을 오래된 것부터 넣는다. 오래된 것부터인 이유: 종류 목록이 시간순으로
// 자라야 "처음 나온 뜻이 이름을 정한다"가 성립한다.
export async function enqueueUnclassified(limit?: number) {
  const q = db
    .select({ id: decisions.id, header: decisions.header, question: decisions.question, options: decisions.options })
    .from(decisions)
    .where(
      sql`not exists (select 1 from ${llmJobs} where ${llmJobs.kind} = ${KIND} and ${llmJobs.subject} = ${decisions.id}::text)`,
    )
    .orderBy(asc(decisions.ts), asc(decisions.id))
  const rows = limit ? await q.limit(limit) : await q
  return enqueue(
    KIND,
    rows.map((r) => ({ subject: String(r.id), input: { header: r.header, question: r.question, options: r.options } })),
  )
}

// 종류별 결정 수와 답 분포. precedents.mjs 가 글자 겹침으로 하던 묶음을 뜻으로 다시 한 결과다.
export async function kindSummary() {
  return db
    .select({
      kind: decisionKinds.kind,
      n: sql<number>`count(*)::int`,
    })
    .from(decisionKinds)
    .innerJoin(decisions, eq(decisions.id, decisionKinds.decisionId))
    .groupBy(decisionKinds.kind)
    .orderBy(sql`count(*) desc`)
}
