// 작업 종류 'taste-diff': 다시 쓰인 에이전트 커밋 하나에서 "누가 무엇으로 바꿨나"를 뽑는다.
//
// 대상: commit_survival 에서 더한 줄 20줄 이상, 남은 비율 70% 이하인 커밋.
// 재료(넣을 때 git 에서 모은다):
//   - 그 커밋이 더했는데 지금 기준 ref 에 없는 줄
//   - 그 뒤 같은 파일을 고친 커밋 가운데 그 줄을 실제로 지운 커밋(최대 4개)과 그 diff, 그리고 누가 했나
// 지운 커밋이 하나도 없는 파일은 넣지 않는다 — 파일이 통째로 옮겨졌거나 사라진 경우라 "무엇으로 바꿨나"가 없다.
//
// 누가 했나는 코드가 정한다(모델에 맡기지 않는다): 레포 user.email 명의 + Claude 표시면 suah-agent,
// 명의만 같으면 suah-hand, 아니면 teammate. 모델은 무엇이 바뀌었고 그게 취향인지를 판단한다.

import { asc, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { commitSurvival, llmJobs, tasteFindings } from '../db/schema.js'
import { baseRef, git } from '../taste.js'
import { norm, roots, TRAILER } from '../taste-blame.js'
import { enqueue, type Handler } from './runner.js'

export const KIND = 'taste-diff'
const MIN_ADDED = 20
const MAX_KEPT = 0.7
const MAX_FILES = 3
const MAX_LATER = 4
const MAX_MISSING = 40
const DIFF_CHARS = 3000

type Who = 'suah-hand' | 'suah-agent' | 'teammate'
type FileInput = { path: string; missing: string[]; later: Array<{ sha: string; who: Who; subject: string; diff: string }> }
type Input = { repo: string; sha: string; subject: string; files: FileInput[] }
type Output = {
  findings: Array<{ file: string; kind: string; byWhom: Who; isTaste: boolean; lesson: string }>
}
const KINDS = ['naming', 'structure', 'comment', 'scope', 'behavior', 'style', 'revert', 'move']

const SYSTEM = `An AI coding agent wrote some lines in a commit for Suah, a frontend engineer. Later commits removed or
rewrote those lines. For each file, you see the agent's lines that are gone now and the later commits that removed
them, with who made each commit (decided by the git author, not by you): suah-hand (Suah herself), suah-agent (Suah's
agent, usually after she corrected it), teammate (someone else on her team).

For each later commit that changed the agent's lines, return one finding:
- kind: naming | structure | comment | scope | behavior | style | revert | move
- byWhom: copy the label given for that commit
- isTaste: true when the change expresses a preference about how code should be written (naming, structure, comment
  density, what belongs in scope), false when it fixes a bug, follows a changed requirement, reverts, or only moves code.
- lesson: when isTaste, one Korean sentence stating the preference as a rule ("주석은 이유만 남기고 동작 설명은 지운다").
  Otherwise an empty string.
Return findings only for changes you can see in the diffs. Do not guess beyond them.`

export const tasteDiffHandler: Handler<Input, Output> = {
  kind: KIND,
  model: 'sonnet',
  concurrency: 3,
  jsonSchema: (input) => ({
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', enum: input.files.map((f) => f.path) },
            kind: { type: 'string', enum: KINDS },
            byWhom: { type: 'string', enum: ['suah-hand', 'suah-agent', 'teammate'] },
            isTaste: { type: 'boolean' },
            lesson: { type: 'string' },
          },
          required: ['file', 'kind', 'byWhom', 'isTaste', 'lesson'],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  }),

  async prompt(input) {
    return {
      system: SYSTEM,
      prompt: [
        `Agent commit: ${input.subject}`,
        ...input.files.map((f) =>
          [
            `\n=== file ${f.path} ===`,
            'Agent lines that are gone now:',
            ...f.missing.map((l) => `  ${l}`),
            ...f.later.map((c) => `\n--- later commit ${c.sha.slice(0, 8)} by ${c.who}: ${c.subject}\n${c.diff}`),
          ].join('\n'),
        ),
      ].join('\n'),
    }
  },

  async apply(tx, job, output) {
    const input = job.input as Input
    await tx.delete(tasteFindings).where(sql`${tasteFindings.repo} = ${input.repo} and ${tasteFindings.sha} = ${input.sha}`)
    if (output.findings.length)
      await tx.insert(tasteFindings).values(
        output.findings.map((f) => ({
          repo: input.repo,
          sha: input.sha,
          file: f.file,
          kind: f.kind as 'naming',
          byWhom: f.byWhom,
          isTaste: f.isTaste,
          lesson: f.isTaste && f.lesson.trim() ? f.lesson.trim() : null,
          jobId: job.id,
        })),
      )
  },
}

export async function enqueueRewritten(limit?: number) {
  const candidates = await db
    .select({ repo: commitSurvival.repo, sha: commitSurvival.sha, subject: commitSurvival.subject })
    .from(commitSurvival)
    .where(
      sql`${commitSurvival.added} >= ${MIN_ADDED} and ${commitSurvival.kept}::float / ${commitSurvival.added} <= ${MAX_KEPT}
        and not exists (select 1 from ${llmJobs} where ${llmJobs.kind} = ${KIND} and ${llmJobs.subject} = ${commitSurvival.repo} || ':' || ${commitSurvival.sha})`,
    )
    .orderBy(asc(commitSurvival.committedAt))
  const rootByName = new Map((await roots()).map((r) => [r.name, r.root]))
  const items: Array<{ subject: string; input: Input }> = []
  for (const c of limit ? candidates.slice(0, limit) : candidates) {
    const root = rootByName.get(c.repo)
    if (!root) continue
    const base = await baseRef(root)
    if (!base) continue
    const me = (await git(root, 'config', 'user.email')).trim().toLowerCase()
    // 그 커밋이 파일별로 더한 줄
    const added = new Map<string, string[]>()
    let path: string | null = null
    for (const l of (await git(root, 'show', '-U0', '--no-renames', '--format=', c.sha)).split('\n')) {
      if (l.startsWith('+++ ')) path = l.slice(4) === '/dev/null' ? null : l.slice(4).replace(/^b\//, '')
      else if (l.startsWith('+') && path) added.set(path, [...(added.get(path) ?? []), l.slice(1)])
    }
    const files: FileInput[] = []
    for (const [p, raw] of added) {
      const now = await git(root, 'show', `${base.ref}:${p}`).then((t) => new Set(norm(t)), () => null)
      if (!now) continue // 파일이 없다 — 옮겨졌거나 지워짐. 바꾼 내용이 없으니 넣지 않는다
      const missing = norm(raw.join('\n')).filter((l) => !now.has(l))
      if (missing.length < 3) continue
      const missingSet = new Set(missing)
      const later: FileInput['later'] = []
      const log = (await git(root, 'log', '--reverse', '--format=%H%x09%ae%x09%s', `${c.sha}..${base.ref}`, '--', p)).split('\n').filter(Boolean)
      for (const entry of log) {
        if (later.length >= MAX_LATER) break
        const [sha, email, ...subj] = entry.split('\t')
        const diff = await git(root, 'show', '-U1', '--format=', sha!, '--', p)
        // 그 커밋이 에이전트 줄을 실제로 지웠나("-" 줄에 있나). 안 지웠으면 이 파일의 다른 곳을 고친 커밋이다.
        const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim())
        if (!removed.some((l) => missingSet.has(l))) continue
        const body = await git(root, 'log', '-1', '--format=%B', sha!)
        const mine = email!.toLowerCase() === me
        const who: Who = mine ? (body.toLowerCase().includes(TRAILER.toLowerCase()) ? 'suah-agent' : 'suah-hand') : 'teammate'
        later.push({ sha: sha!, who, subject: subj.join('\t'), diff: diff.slice(0, DIFF_CHARS) })
      }
      if (later.length) files.push({ path: p, missing: missing.slice(0, MAX_MISSING), later })
    }
    files.sort((a, b) => b.missing.length - a.missing.length)
    if (files.length) items.push({ subject: `${c.repo}:${c.sha}`, input: { repo: c.repo, sha: c.sha, subject: c.subject, files: files.slice(0, MAX_FILES) } })
  }
  return enqueue(KIND, items)
}

