// 작업 종류 'answer-policy': 질문 종류 하나의 답들을 정책으로 묶는다.
//
// 작업 하나 = 질문 종류 하나. 그 종류에서 수아가 답한 결정을 전부 보여주고, 정책 목록과
// 결정별 배정을 한 번에 받는다(schema.ts answerPolicies 주석). 결정이 새로 쌓이면 결정 목록이
// 바뀌므로 subject(목록의 해시)도 바뀌고 새 작업이 생긴다. 새 작업은 그 종류의 정책을 통째로 갈아 끼운다.
//
// 답이 하나뿐인 종류는 넣지 않는다. 정책은 "같은 판단이 쌓였나"를 보려는 것이라 답이 둘 이상이어야 뜻이 있다.
//
// 실패 지점: 모델이 정책을 "추천대로 함" 같은 형식으로 지으면 묶음이 무의미해진다(추천은 질문마다 다르다).
// 프롬프트에서 금지하지만, 정책 이름을 읽어 보고 걸러야 한다.

import { createHash } from 'node:crypto'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { answerPolicies, decisionKinds, decisionPolicies, decisions, questionKinds } from '../db/schema.js'
import { enqueue, type Handler } from './runner.js'
import { strip } from './shadow-predict.js'

export const KIND = 'answer-policy'

type Item = { id: number; question: string; options: string[]; chosen: string; freeText: boolean }
type Input = { kind: string; description: string; decisions: Item[] }
type Output = { policies: Array<{ name: string; description: string }>; assignments: Array<{ id: number; policy: string }> }

const SYSTEM = `You group Suah's answers to one kind of question into answer policies.

All questions below are the same kind of decision, but their option labels differ. A policy names the
stance Suah took, in a way that carries across questions: "ship now and push", "defer to a separate
ticket", "keep scope to what the ticket says". Two answers share a policy when the same standing rule
would have produced both.

Rules:
- Never name a policy after the agent's recommendation ("followed the recommendation", "chose the
  recommended option"). The recommendation differs per question; name what was decided.
- Prefer few policies. One policy per answer means you found no pattern; that is allowed but say so by
  giving each a precise name.
- A free-text answer (typed instead of picked) gets a policy like any other.
- Policy names are short Korean phrases (2 to 6 words). Descriptions are one Korean sentence.
- Assign every decision id exactly once, to one of the policies you return.`

export const answerPolicyHandler: Handler<Input, Output> = {
  kind: KIND,
  // 질문마다 다른 문구 밑의 같은 판단을 알아보는 일이라 Haiku 보다 한 단계 위를 쓴다.
  // 종류 수(수십)만큼만 부르므로 비용은 작다.
  model: 'sonnet',
  concurrency: 4,
  jsonSchema: (input) => ({
    type: 'object',
    properties: {
      policies: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, description: { type: 'string' } },
          required: ['name', 'description'],
          additionalProperties: false,
        },
      },
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'integer', enum: input.decisions.map((d) => d.id) }, policy: { type: 'string' } },
          required: ['id', 'policy'],
          additionalProperties: false,
        },
      },
    },
    required: ['policies', 'assignments'],
    additionalProperties: false,
  }),

  async prompt(input) {
    return {
      system: SYSTEM,
      prompt: [
        `Kind: ${input.kind} — ${input.description}`,
        '',
        ...input.decisions.map((d) =>
          [
            `=== decision ${d.id} ===`,
            `question: ${d.question}`,
            `options: ${d.options.join(' | ')}`,
            `Suah ${d.freeText ? 'typed' : 'chose'}: ${d.chosen}`,
          ].join('\n'),
        ),
      ].join('\n'),
    }
  },

  async apply(tx, job, output) {
    const input = job.input as Input
    const names = new Map(output.policies.map((p) => [p.name.trim(), p.description.trim()]))
    const got = new Map(output.assignments.map((a) => [a.id, a.policy.trim()]))
    // 빠지거나 목록에 없는 정책을 가리키면 종류 전체를 실패시킨다. 일부만 넣으면 그 종류의 정책이
    // "일부 결정만 본 목록"이 되어 settled/drift 판정이 조용히 틀린다.
    const missing = input.decisions.filter((d) => !got.has(d.id))
    if (missing.length) throw new Error(`배정이 빠진 결정 ${missing.length}건`)
    const unknown = [...got.values()].filter((p) => !names.has(p))
    if (unknown.length) throw new Error(`목록에 없는 정책: ${[...new Set(unknown)].join(', ')}`)

    // 그 종류를 통째로 갈아 끼운다. 이전 작업이 만든 정책과 배정을 지우고 새로 넣는다.
    await tx.delete(decisionPolicies).where(eq(decisionPolicies.kind, input.kind))
    await tx.delete(answerPolicies).where(eq(answerPolicies.kind, input.kind))
    await tx.insert(answerPolicies).values([...names].map(([name, description]) => ({ kind: input.kind, name, description, jobId: job.id })))
    await tx
      .insert(decisionPolicies)
      .values(input.decisions.map((d) => ({ decisionId: d.id, kind: input.kind, policy: got.get(d.id)!, jobId: job.id })))
  },
}

// 답이 둘 이상인 종류마다 작업 하나. 결정 목록이 그대로면 subject 가 같아서 다시 안 들어간다.
export async function enqueueKinds(limit?: number) {
  const rows = await db
    .select({
      kind: decisionKinds.kind,
      description: questionKinds.description,
      id: decisions.id,
      question: decisions.question,
      options: decisions.options,
      chosen: decisions.chosen,
    })
    .from(decisionKinds)
    .innerJoin(decisions, eq(decisions.id, decisionKinds.decisionId))
    .innerJoin(questionKinds, eq(questionKinds.name, decisionKinds.kind))
    .where(sql`${decisions.chosen} is not null`)
    .orderBy(asc(decisionKinds.kind), asc(decisions.ts), asc(decisions.id))

  const byKind = new Map<string, Input>()
  for (const r of rows) {
    const input = byKind.get(r.kind) ?? { kind: r.kind, description: r.description, decisions: [] }
    const options = r.options.map(strip)
    const picked = r.chosen!.split(', ').map(strip)
    const freeText = !picked.every((p) => options.includes(p))
    input.decisions.push({ id: r.id, question: r.question, options, chosen: freeText ? r.chosen! : picked.join(', '), freeText })
    byKind.set(r.kind, input)
  }
  const items = [...byKind.values()]
    .filter((k) => k.decisions.length >= 2)
    .map((k) => ({
      subject: `${k.kind}#${createHash('sha1').update(k.decisions.map((d) => d.id).join(',')).digest('hex').slice(0, 12)}`,
      input: k,
    }))
  return enqueue(KIND, limit ? items.slice(0, limit) : items)
}

// 종류별 정책 분포. precedents 내보내기와 점수판이 쓴다.
export async function policiesFor(decisionIds: number[]) {
  if (!decisionIds.length) return new Map<number, string>()
  const rows = await db
    .select({ id: decisionPolicies.decisionId, policy: decisionPolicies.policy })
    .from(decisionPolicies)
    .where(inArray(decisionPolicies.decisionId, decisionIds))
  return new Map(rows.map((r) => [r.id, r.policy]))
}
