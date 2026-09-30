// 작업 종류 'correction-replay': 교정으로 분류된 메시지 하나를 그 시점의 브레인에 비춰 원인을 가른다.
//
// 재료: 교정 직전 에이전트 글, 교정 메시지, 그 시각 직전 커밋의 sense.md.
// 답: 원인(missing/ignored/wrong/not-judgment), 관련 규칙 id, inbox 한 줄 초안, 이유.
//
// 모델은 Opus 다. shadow-predict 와 같은 이유 — 판단 문서 전체를 읽고 규칙과 상황을 맞대는 일이다.
// 동시에 여러 개 돌려도 된다. 교정마다 독립이다.
//
// 실패 지점: 에이전트 글의 끝부분만 보여준다. 교정이 그보다 앞선 행동(몇 턴 전의 커밋 등)을
// 가리키면 모델은 무엇이 틀렸는지 추측한다. 이유 칸이 그 추측을 드러내야 읽는 사람이 거를 수 있다.

import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { correctionReplays, llmJobs, messageIntents, messages } from '../db/schema.js'
import { enqueue, type Handler } from './runner.js'
import { commitBefore, senseAt } from './shadow-predict.js'

export const KIND = 'correction-replay'

const CAUSES = ['missing', 'ignored', 'wrong', 'not-judgment'] as const
const CONTEXT_CHARS = 3000
const MESSAGE_CHARS = 2000

// ruleIds: 그 커밋의 sense.md 에 실제로 있는 규칙 id. 답의 rule 을 이 목록으로 묶는다.
// 처음엔 자유 문자열이었고, 첫 세 건에서 모델이 "BI-4" 를 댔다 — 09-10 에 지워진 id 를 형식까지
// 틀리게 지어낸 것이다. 규칙 id 는 집계의 열쇠라서 지어낸 id 하나가 "없는 규칙이 무시됐다"는 숫자가 된다.
type Input = { messageId: string; text: string; before: string | null; brainCommit: string; ruleIds: string[] }
type Output = { cause: (typeof CAUSES)[number]; rule: string; inboxDraft: string; reason: string }

export const correctionReplayHandler: Handler<Input, Output> = {
  kind: KIND,
  model: 'opus',
  concurrency: 2,
  jsonSchema: (input) => ({
    type: 'object',
    properties: {
      cause: { type: 'string', enum: [...CAUSES] },
      rule: { type: 'string', enum: ['', ...input.ruleIds], description: 'rule id from the guide, or empty' },
      inboxDraft: { type: 'string', description: 'one English line, or empty for not-judgment' },
      reason: { type: 'string' },
    },
    required: ['cause', 'rule', 'inboxDraft', 'reason'],
    additionalProperties: false,
  }),

  async prompt(input) {
    const sense = await senseAt(input.brainCommit)
    return {
      system: [
        'Suah corrected an AI coding agent. Decide why the agent needed correcting, judged against her judgment guide',
        'as it stood at that moment (below).',
        '',
        'cause:',
        '- missing: no rule in the guide covers this; a new rule would have prevented it.',
        '- ignored: a rule covers it and the agent did not follow it. Give the rule id.',
        '- wrong: the agent followed a rule and Suah still corrected it, so the rule itself is wrong or too broad. Give the rule id.',
        '- not-judgment: a typo, a factual slip, a tool failure, or a preference too local to be a rule.',
        '',
        'inboxDraft: one English line in the style "YYYY-MM-DD (correction): <what happened> — <the generalizable lesson>",',
        'with company, product, and ticket names generalized. Empty for not-judgment.',
        'reason: one or two Korean sentences. If you had to guess what the agent did wrong because the text is cut off, say so.',
        '',
        '----- identity/sense.md -----',
        sense,
      ].join('\n'),
      prompt: [
        'Agent text before the correction (the end of it):',
        input.before ? input.before.slice(-CONTEXT_CHARS) : '(none)',
        '',
        "Suah's correction:",
        input.text.slice(0, MESSAGE_CHARS),
      ].join('\n'),
    }
  },

  async apply(tx, job, output) {
    const input = job.input as Input
    const row = {
      jobId: job.id,
      brainCommit: input.brainCommit,
      cause: output.cause,
      rule: output.rule.trim() || null,
      inboxDraft: output.inboxDraft.trim() || null,
      reason: output.reason,
    }
    await tx
      .insert(correctionReplays)
      .values({ messageId: input.messageId, ...row })
      .onConflictDoUpdate({ target: correctionReplays.messageId, set: row })
  },
}

// 교정으로 분류된 메시지 가운데 아직 되짚지 않은 것.
export async function enqueueCorrections(limit?: number) {
  const before = db.$with('before').as(db.select({ id: messages.id, text: messages.text }).from(messages))
  const q = db
    .with(before)
    .select({ id: messages.id, ts: messages.ts, text: messages.text, before: before.text })
    .from(messages)
    .innerJoin(messageIntents, eq(messageIntents.messageId, messages.id))
    .leftJoin(before, eq(before.id, messages.replyTo))
    .where(
      sql`${messageIntents.intent} = 'correction'
        and not exists (select 1 from ${llmJobs} where ${llmJobs.kind} = ${KIND} and ${llmJobs.subject} = ${messages.id})`,
    )
    .orderBy(asc(messages.ts))
  const rows = limit ? await q.limit(limit) : await q
  const items = []
  for (const r of rows) {
    const brainCommit = await commitBefore(r.ts)
    // 규칙 줄은 "- `BI-10` ..." 모양이다(sense.md Rule Ids 절). 본문 속 언급도 잡히지만 같은 id 라 상관없다.
    const ruleIds = [...new Set([...(await senseAt(brainCommit)).matchAll(/`([A-Z]{2}-\d{2})`/g)].map((m) => m[1]!))].sort()
    items.push({ subject: r.id, input: { messageId: r.id, text: r.text, before: r.before, brainCommit, ruleIds } })
  }
  return enqueue(KIND, items)
}
