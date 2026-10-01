// 작업 종류 'taste-theme': 취향 규칙 후보(taste_findings 의 수아 쪽 취향)를 주제로 묶고 브레인과 맞댄다.
//
// 작업 하나가 전부를 본다(draft-theme 와 같은 이유: 나눠 묶으면 같은 주제가 이름만 다르게 여러 번 생긴다).
// 브레인은 지금(작업 트리) 판단 문서 두 개를 준다 — sense.md(판단 규칙)와 principles.md(코드·구조 원칙).
// 취향 규칙은 대개 principles.md 쪽에 있어서 sense.md 만 주면 "새 규칙"이 부풀려진다.
//
// 결과는 통째로 갈아 끼우되, 수아가 이미 결정한(accepted/rejected) 주제는 지우지 않는다.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { tasteFindings, tasteThemes } from '../db/schema.js'
import { BRAIN_DIR } from '../brain.js'
import { enqueue, type Handler } from './runner.js'

export const KIND = 'taste-theme'

type Input = { findings: Array<{ id: number; kind: string; lesson: string }> }
type Output = {
  themes: Array<{ lesson: string; summaryKo: string; findingIds: number[]; covered: 'none' | 'partial' | 'full'; coveredBy: string }>
}

const SYSTEM = `You consolidate coding-taste rule candidates for Suah's judgment guide. Each candidate was extracted from a
real case where her agent's code was rewritten after she corrected it.

1. Merge candidates that state the same preference in different words into one theme.
2. For each theme, check the guide documents below. covered = "full" if a rule already says this (give its id or
   heading in coveredBy), "partial" if a rule is near but does not cover this case (say which in coveredBy),
   "none" if nothing covers it (coveredBy empty).
3. lesson: one English line for the guide's inbox, stating the preference as a rule, generalized (no company,
   product, or ticket names). summaryKo: the same in one plain Korean sentence.
Every candidate id goes into exactly one theme.`

export const tasteThemeHandler: Handler<Input, Output> = {
  kind: KIND,
  model: 'sonnet',
  jsonSchema: (input) => ({
    type: 'object',
    properties: {
      themes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lesson: { type: 'string' },
            summaryKo: { type: 'string' },
            findingIds: { type: 'array', items: { type: 'integer', enum: input.findings.map((f) => f.id) } },
            covered: { type: 'string', enum: ['none', 'partial', 'full'] },
            coveredBy: { type: 'string' },
          },
          required: ['lesson', 'summaryKo', 'findingIds', 'covered', 'coveredBy'],
          additionalProperties: false,
        },
      },
    },
    required: ['themes'],
    additionalProperties: false,
  }),

  async prompt(input) {
    const doc = (p: string) => readFile(join(BRAIN_DIR, p), 'utf8').catch(() => '(missing)')
    return {
      system: [SYSTEM, '', '----- identity/sense.md -----', await doc('identity/sense.md'), '', '----- identity/principles.md -----', await doc('identity/principles.md')].join('\n'),
      prompt: input.findings.map((f) => `#${f.id} [${f.kind}] ${f.lesson}`).join('\n'),
    }
  },

  async apply(tx, job, output) {
    const input = job.input as Input
    const seen = new Set(output.themes.flatMap((t) => t.findingIds))
    const missing = input.findings.filter((f) => !seen.has(f.id))
    if (missing.length) throw new Error(`주제가 빠진 후보 ${missing.length}건`)
    await tx.delete(tasteThemes).where(sql`${tasteThemes.status} = 'pending'`)
    await tx.insert(tasteThemes).values(
      output.themes.map((t) => ({
        lesson: t.lesson.trim(),
        summaryKo: t.summaryKo.trim(),
        count: t.findingIds.length,
        covered: t.covered,
        coveredBy: t.coveredBy.trim() || null,
        jobId: job.id,
      })),
    )
  },
}

export async function enqueueThemes() {
  const rows = await db
    .select({ id: tasteFindings.id, kind: tasteFindings.kind, lesson: sql<string>`${tasteFindings.lesson}` })
    .from(tasteFindings)
    .where(sql`${tasteFindings.isTaste} and ${tasteFindings.lesson} is not null and ${tasteFindings.byWhom} <> 'teammate'`)
    .orderBy(tasteFindings.id)
  if (rows.length < 2) return 0
  const subject = createHash('sha1').update(rows.map((r) => r.id).join(',')).digest('hex').slice(0, 12)
  return enqueue(KIND, [{ subject, input: { findings: rows } }])
}
