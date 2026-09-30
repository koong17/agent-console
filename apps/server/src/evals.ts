import { Type } from 'typebox'
import { writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { App } from './app.js'
import { db } from './db/index.js'
import { correctionReplays, evalDrafts, messages } from './db/schema.js'
import { DateTime, Nullable } from './schemas.js'
import { BRAIN_DIR } from './brain.js'
import { CASES_DIR } from './jobs/eval-draft.js'

// eval 초안 대기열(/evals/drafts). 콘솔의 첫 쓰기 경로다.
//
// 지금까지 이 서버는 읽기만 했다(적재는 파일 → DB 방향). 여기서 처음으로 DB → 다른 레포의 파일로 쓴다.
// 그래서 두 가지를 지킨다.
//   1) 같은 초안을 두 번 쓰지 않는다. 버튼을 두 번 누르거나 탭 두 개에서 동시에 눌러도 파일은 하나다.
//   2) 이미 있는 파일을 덮지 않는다. 수아나 브레인 세션이 같은 이름으로 만든 케이스가 있으면 멈춘다.
// 쓰는 파일은 status: draft 라 run-evals 에 섞이지 않고, 커밋은 하지 않는다 — 브레인 레포의 커밋은
// 그 레포 세션의 규칙을 따른다.

const Draft = Type.Object({
  messageId: Type.String(),
  ts: DateTime,
  correction: Type.String(),
  cause: Type.String(),
  caseId: Type.String(),
  title: Type.String(),
  rules: Type.Array(Type.String()),
  body: Type.String(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('rejected')]),
  decidedAt: Nullable(DateTime),
  path: Nullable(Type.String()),
})

const Decided = Type.Object({ status: Type.String(), path: Nullable(Type.String()) })
const Conflict = Type.Object({ error: Type.String(), status: Type.String() })
const Params = Type.Object({ messageId: Type.String() })

export function evalRoutes(app: App) {
  app.get('/evals/drafts', { schema: { response: { 200: Type.Array(Draft) } } }, async () => {
    const rows = await db
      .select({
        messageId: evalDrafts.messageId,
        ts: messages.ts,
        correction: messages.text,
        cause: correctionReplays.cause,
        caseId: evalDrafts.caseId,
        title: evalDrafts.title,
        rules: evalDrafts.rules,
        body: evalDrafts.body,
        status: evalDrafts.status,
        decidedAt: evalDrafts.decidedAt,
        path: evalDrafts.path,
      })
      .from(evalDrafts)
      .innerJoin(messages, eq(messages.id, evalDrafts.messageId))
      .innerJoin(correctionReplays, eq(correctionReplays.messageId, evalDrafts.messageId))
      // 결정할 것(pending)을 먼저, 그 안에서는 최근 교정부터.
      .orderBy(sql`${evalDrafts.status} <> 'pending'`, desc(messages.ts))
    return rows.map((r) => ({ ...r, correction: r.correction.slice(0, 500) }))
  })

  app.post(
    '/evals/drafts/:messageId/accept',
    { schema: { params: Params, response: { 200: Decided, 404: Conflict, 409: Conflict } } },
    async (req, reply) => {
      const { messageId } = req.params
      // 먼저 DB 에서 pending → accepted 를 조건부로 바꾼다. 이 한 문장이 잠금이다: 두 요청이 동시에 와도
      // 조건(status = 'pending')을 통과하는 건 하나뿐이고, 나머지는 returning 이 빈다.
      // 파일을 먼저 쓰고 DB 를 나중에 바꾸면, 그 사이에 실패했을 때 "파일은 있는데 pending" 이 남는다.
      const [won] = await db
        .update(evalDrafts)
        .set({ status: 'accepted', decidedAt: new Date() })
        .where(and(eq(evalDrafts.messageId, messageId), eq(evalDrafts.status, 'pending')))
        .returning({ caseId: evalDrafts.caseId, body: evalDrafts.body })
      if (!won) {
        const [cur] = await db.select({ status: evalDrafts.status }).from(evalDrafts).where(eq(evalDrafts.messageId, messageId))
        if (!cur) return reply.code(404).send({ error: '초안이 없어요', status: 'missing' })
        return reply.code(409).send({ error: '이미 결정한 초안이에요', status: cur.status })
      }
      const file = join(CASES_DIR, `${won.caseId}.md`)
      try {
        // wx: 파일이 이미 있으면 실패한다(덮어쓰지 않음). 두 번째 벽이다 — DB 가 모르는 파일
        // (사람이 직접 만든 같은 이름의 케이스)까지 막는다.
        await writeFile(file, won.body, { flag: 'wx' })
      } catch (err) {
        // 파일을 못 썼으면 결정을 되돌린다. 안 되돌리면 "accepted 인데 파일 없음" 이 남는다.
        await db.update(evalDrafts).set({ status: 'pending', decidedAt: null }).where(eq(evalDrafts.messageId, messageId))
        const exists = (err as NodeJS.ErrnoException).code === 'EEXIST'
        return reply
          .code(409)
          .send({ error: exists ? `같은 이름의 케이스가 이미 있어요: ${won.caseId}.md` : `파일을 못 썼어요: ${(err as Error).message}`, status: 'pending' })
      }
      const path = relative(BRAIN_DIR, file)
      await db.update(evalDrafts).set({ path }).where(eq(evalDrafts.messageId, messageId))
      return { status: 'accepted', path }
    },
  )

  app.post(
    '/evals/drafts/:messageId/reject',
    { schema: { params: Params, response: { 200: Decided, 404: Conflict, 409: Conflict } } },
    async (req, reply) => {
      const { messageId } = req.params
      const [won] = await db
        .update(evalDrafts)
        .set({ status: 'rejected', decidedAt: new Date() })
        .where(and(eq(evalDrafts.messageId, messageId), eq(evalDrafts.status, 'pending')))
        .returning({ messageId: evalDrafts.messageId })
      if (!won) {
        const [cur] = await db.select({ status: evalDrafts.status }).from(evalDrafts).where(eq(evalDrafts.messageId, messageId))
        if (!cur) return reply.code(404).send({ error: '초안이 없어요', status: 'missing' })
        return reply.code(409).send({ error: '이미 결정한 초안이에요', status: cur.status })
      }
      return { status: 'rejected', path: null }
    },
  )
}
