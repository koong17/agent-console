// 작업 종류 'draft-theme': 규칙 없음 초안 전체를 주제로 묶는다. 작업 하나가 전부를 본다.
//
// 넘기는 건 초안마다 제목과 Anti-pattern 절(무엇이 틀렸나)뿐이다. Scenario 까지 넣으면 134개가
// 수십만 자라 한 번에 안 들어가고, 주제를 가르는 데는 "무엇이 틀렸나"면 충분하다.
//
// 초안이 새로 생기면 목록이 바뀌어 subject(해시)가 바뀌고 새 작업이 생긴다. 새 작업은 주제를 통째로 갈아 끼운다
// (answer-policy 와 같은 방식). 수아가 이미 저장하거나 버린 초안도 같이 묶는다 — 주제의 크기가 곧
// "이 새 규칙이 몇 번 필요했나"라서, 결정했다고 빼면 크기가 거짓이 된다.

import { createHash } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { correctionReplays, draftThemes, evalDrafts } from '../db/schema.js'
import { enqueue, type Handler } from './runner.js'

export const KIND = 'draft-theme'

type Input = { drafts: Array<{ caseId: string; title: string; antiPattern: string }> }
type Output = {
  themes: Array<{ name: string; description: string; representative: string }>
  assignments: Array<{ caseId: string; theme: string }>
}

const SYSTEM = `You group draft regression cases for an AI coding agent's judgment guide. Each draft records one
real mistake that no rule in the guide covered. Group them by the rule that would have prevented them: one theme
= one candidate rule. Two drafts share a theme when the same one-sentence rule would have stopped both.

- Theme names: short Korean phrases stating the rule (e.g. "사실은 추측으로 채우지 않는다"). Descriptions: one Korean sentence.
- representative: the caseId of the draft that best shows the theme.
- A draft that fits no theme gets its own theme. Do not force it into a vague one.
- Assign every caseId exactly once.`

export const draftThemeHandler: Handler<Input, Output> = {
  kind: KIND,
  model: 'sonnet',
  jsonSchema: (input) => {
    const ids = input.drafts.map((d) => d.caseId)
    return {
      type: 'object',
      properties: {
        themes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' }, representative: { type: 'string', enum: ids } },
            required: ['name', 'description', 'representative'],
            additionalProperties: false,
          },
        },
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: { caseId: { type: 'string', enum: ids }, theme: { type: 'string' } },
            required: ['caseId', 'theme'],
            additionalProperties: false,
          },
        },
      },
      required: ['themes', 'assignments'],
      additionalProperties: false,
    }
  },

  async prompt(input) {
    return {
      system: SYSTEM,
      prompt: input.drafts.map((d) => `=== ${d.caseId} ===\n${d.title}\nMistake: ${d.antiPattern}`).join('\n\n'),
    }
  },

  async apply(tx, _job, output) {
    const input = _job.input as Input
    const themes = new Map(output.themes.map((t) => [t.name.trim(), t]))
    const got = new Map(output.assignments.map((a) => [a.caseId, a.theme.trim()]))
    const missing = input.drafts.filter((d) => !got.has(d.caseId))
    if (missing.length) throw new Error(`주제가 빠진 초안 ${missing.length}건`)
    const unknown = [...new Set([...got.values()].filter((t) => !themes.has(t)))]
    if (unknown.length) throw new Error(`목록에 없는 주제: ${unknown.join(', ')}`)
    // 대표 초안이 자기 주제에 배정돼 있지 않으면 화면에서 "대표"가 다른 주제 밑에 나온다.
    const wrongRep = [...themes.values()].filter((t) => got.get(t.representative) !== t.name.trim())
    if (wrongRep.length) throw new Error(`대표 초안이 다른 주제에 배정됨: ${wrongRep.map((t) => t.name).join(', ')}`)

    await tx.update(evalDrafts).set({ theme: null }).where(sql`${evalDrafts.theme} is not null`)
    await tx.delete(draftThemes)
    await tx.insert(draftThemes).values(
      [...themes.values()].map((t) => ({ name: t.name.trim(), description: t.description.trim(), representative: t.representative, jobId: _job.id })),
    )
    for (const [caseId, theme] of got) await tx.update(evalDrafts).set({ theme }).where(eq(evalDrafts.caseId, caseId))
  },
}

// Anti-pattern 절만 잘라낸다. 초안 본문은 renderCase 가 만든 고정 모양이라 절 제목으로 자를 수 있다.
const antiPatternOf = (body: string) => body.split('## Anti-pattern')[1]?.trim() ?? ''

export async function enqueueThemes() {
  const rows = await db
    .select({ caseId: evalDrafts.caseId, title: evalDrafts.title, body: evalDrafts.body })
    .from(evalDrafts)
    .innerJoin(correctionReplays, eq(correctionReplays.messageId, evalDrafts.messageId))
    .where(eq(correctionReplays.cause, 'missing'))
    .orderBy(asc(evalDrafts.caseId))
  if (rows.length < 2) return 0
  const drafts = rows.map((r) => ({ caseId: r.caseId, title: r.title, antiPattern: antiPatternOf(r.body) }))
  const subject = createHash('sha1').update(drafts.map((d) => d.caseId).join(',')).digest('hex').slice(0, 12)
  return enqueue(KIND, [{ subject, input: { drafts } }])
}

