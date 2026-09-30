// 작업 종류 'eval-draft': 교정 되짚기 하나를 eval 케이스 초안으로 옮긴다.
//
// 대상은 원인이 missing(규칙 없음) 또는 ignored(규칙 무시)인 교정이다.
//   missing → 이 케이스는 지금 브레인으로 실패해야 정상이다. 규칙을 새로 쓰면 통과한다.
//   ignored → 규칙은 있다. 케이스가 그 규칙이 실제로 읽히는지를 지킨다.
// wrong 과 not-judgment 는 뺀다. 틀린 규칙을 지키는 케이스를 만들면 안 되고, 판단 문제가 아닌 건 시험할 게 없다.
//
// Scenario 는 실수하기 직전에서 끝나야 한다. 첫 초안 3건은 교정 문장까지 넣고 "다음에 뭘 하나"를 물어서,
// 판단이 아니라 "혼난 뒤 수습"을 시험하는 케이스가 됐다. 그걸 막는 줄이 프롬프트에 있다.
//
// 모델이 쓰는 건 제목·규칙·세 절(Scenario/Expected/Anti-pattern) 내용뿐이다. frontmatter 와 파일 모양은
// 코드가 만든다 — 형식을 모델에 맡기면 run-evals.mjs 의 파서가 못 읽는 파일이 섞인다.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { correctionReplays, evalDrafts, llmJobs, messages } from '../db/schema.js'
import { BRAIN_DIR } from '../brain.js'
import { enqueue, type Handler } from './runner.js'

export const KIND = 'eval-draft'
export const CASES_DIR = join(BRAIN_DIR, 'evals', 'cases')
const CONTEXT_CHARS = 3000

type Input = {
  messageId: string
  correction: string
  before: string | null
  cause: 'missing' | 'ignored'
  rule: string | null
  reason: string
  inboxDraft: string | null
}
type Output = { slug: string; title: string; rules: string[]; scenario: string; expected: string; antiPattern: string }

const SYSTEM = `You turn one real correction into a regression test case for an AI coding agent's judgment guide.

The case is run later like this: a model reads only the guide and your Scenario, answers what it does next,
and a judge compares the answer against Expected and Anti-pattern. The case tests whether the agent makes the
right call in the first place, so:
- Scenario: the situation at the moment BEFORE the agent made the mistake — what it was asked and what it knew.
  Never include the agent's wrong action or Suah's correction; those are only your evidence of what went wrong.
  Write in English; quote the user's request in Korean as she would write it. Suah is a frontend engineer; do not
  invent other roles for her. Generalize company, product, ticket, and person names. Give enough context that the
  right call is decidable without the original conversation. End with "What do you do next?".
- Expected: the one core decision a Suah-aligned agent makes, plus at most two supporting behaviors. Substance,
  not wording.
- Anti-pattern: what the agent actually did that got corrected, stated generally.
- slug: lowercase kebab-case, 3 to 7 words, describing the judgment (no rule id, the code adds it).
- rules: the guide rule ids this case guards. For a rule that was ignored, that rule. For a missing rule, an
  empty list.
- title: one short English line.`

// 파일 이름 앞머리. 기존 케이스는 규칙 id 소문자로 시작한다(as-02-...). 규칙이 없으면 new-.
const prefix = (rules: string[]) => (rules[0] ? rules[0].toLowerCase() : 'new')

export function renderCase(caseId: string, today: string, o: Output) {
  return [
    '---',
    `id: ${caseId}`,
    'kind: eval',
    // run-evals.mjs 는 active 만 돌린다. 초안은 브레인 세션이 읽고 고쳐서 active 로 바꾼다.
    'status: draft',
    `updated: ${today}`,
    `rules: ${JSON.stringify(o.rules)}`,
    '---',
    '',
    `# ${o.title.trim()}`,
    '',
    '## Scenario',
    '',
    o.scenario.trim(),
    '',
    '## Expected',
    '',
    o.expected.trim(),
    '',
    '## Anti-pattern',
    '',
    o.antiPattern.trim(),
    '',
  ].join('\n')
}

export const evalDraftHandler: Handler<Input, Output> = {
  kind: KIND,
  model: 'sonnet',
  // 하나씩. apply 가 "이미 쓰인 id" 를 보고 새 id 를 고르는데, 둘이 동시에 돌면 서로의 아직 커밋 안 된
  // 행을 못 봐서 같은 slug 에 같은 id 를 고를 수 있다. 초안은 수십 건이라 하나씩 돌려도 몇 분이다.
  concurrency: 1,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+){2,6}$' },
      title: { type: 'string' },
      rules: { type: 'array', items: { type: 'string', pattern: '^[A-Z]{2}-\\d{2}$' } },
      scenario: { type: 'string' },
      expected: { type: 'string' },
      antiPattern: { type: 'string' },
    },
    required: ['slug', 'title', 'rules', 'scenario', 'expected', 'antiPattern'],
    additionalProperties: false,
  },

  async prompt(input) {
    return {
      system: SYSTEM,
      prompt: [
        `Cause: ${input.cause === 'missing' ? 'no rule in the guide covered this' : `the agent ignored rule ${input.rule}`}`,
        `Why (from the replay): ${input.reason}`,
        input.inboxDraft ? `Lesson draft: ${input.inboxDraft}` : '',
        '',
        'Agent text before the correction (the end of it):',
        input.before ? input.before.slice(-CONTEXT_CHARS) : '(none)',
        '',
        "Suah's correction:",
        input.correction,
      ]
        .filter((l) => l !== '')
        .join('\n'),
    }
  },

  async apply(tx, job, output) {
    const input = job.input as Input
    // 규칙 무시였는데 모델이 그 규칙을 빼먹으면 채워 넣는다. 케이스가 지키는 규칙이 frontmatter 에 없으면
    // holdout 모드가 그 줄을 못 뺀다.
    const rules = input.cause === 'ignored' && input.rule && !output.rules.includes(input.rule) ? [input.rule, ...output.rules] : output.rules
    // 기존 케이스 파일, 다른 초안과 겹치지 않는 id. 겹치면 -2, -3 을 붙인다.
    const taken = new Set([
      ...(await readdir(CASES_DIR).catch(() => [] as string[])).map((f) => f.replace(/\.md$/, '')),
      ...(await tx.select({ id: evalDrafts.caseId }).from(evalDrafts)).map((r) => r.id),
    ])
    const base = `${prefix(rules)}-${output.slug}`
    let caseId = base
    for (let n = 2; taken.has(caseId); n++) caseId = `${base}-${n}`
    const today = new Date().toISOString().slice(0, 10)
    const row = { jobId: job.id, caseId, title: output.title.trim(), rules, body: renderCase(caseId, today, { ...output, rules }) }
    await tx
      .insert(evalDrafts)
      .values({ messageId: input.messageId, ...row })
      // 이미 결정한(accepted/rejected) 초안은 다시 돌려도 안 덮는다. 수아가 고른 결과가 기준이다.
      .onConflictDoUpdate({ target: evalDrafts.messageId, set: row, setWhere: sql`${evalDrafts.status} = 'pending'` })
  },
}

export async function enqueueReplays(limit?: number) {
  const q = db
    .select({
      messageId: correctionReplays.messageId,
      correction: messages.text,
      replyTo: messages.replyTo,
      cause: correctionReplays.cause,
      rule: correctionReplays.rule,
      reason: correctionReplays.reason,
      inboxDraft: correctionReplays.inboxDraft,
    })
    .from(correctionReplays)
    .innerJoin(messages, eq(messages.id, correctionReplays.messageId))
    .where(
      sql`${correctionReplays.cause} in ('missing', 'ignored')
        and not exists (select 1 from ${llmJobs} where ${llmJobs.kind} = ${KIND} and ${llmJobs.subject} = ${correctionReplays.messageId})`,
    )
    .orderBy(asc(messages.ts))
  const rows = limit ? await q.limit(limit) : await q
  const items = []
  for (const r of rows) {
    const before = r.replyTo
      ? ((await db.select({ text: messages.text }).from(messages).where(eq(messages.id, r.replyTo)))[0]?.text ?? null)
      : null
    items.push({
      subject: r.messageId,
      input: {
        messageId: r.messageId,
        correction: r.correction,
        before,
        cause: r.cause as 'missing' | 'ignored',
        rule: r.rule,
        reason: r.reason,
        inboxDraft: r.inboxDraft,
      },
    })
  }
  return enqueue(KIND, items)
}
