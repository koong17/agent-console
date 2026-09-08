import { Type } from 'typebox'
import type { App } from './app.js'
import { DateTime, Nullable } from './schemas.js'
import { asc, count, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { sessions, turns, modelPrices } from './db/schema.js'
import { turnCostUsd, totalCostUsd } from './cost.js'

const sumInt = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::bigint`.mapWith(Number)

const SessionSummary = Type.Object({
  id: Type.String(),
  repo: Type.String(),
  gitBranch: Nullable(Type.String()),
  startedAt: DateTime,
  lastSeenAt: DateTime,
  turns: Type.Integer(),
  models: Type.Array(Type.String()),
  outputTokens: Type.Integer(),
  costUsd: Nullable(Type.Number()),
})

const Session = Type.Object({
  id: Type.String(),
  cwd: Type.String(),
  repo: Type.String(),
  gitBranch: Nullable(Type.String()),
  cliVersion: Nullable(Type.String()),
  startedAt: DateTime,
  lastSeenAt: DateTime,
})

const TurnWithCost = Type.Object({
  id: Type.String(),
  ts: DateTime,
  model: Type.String(),
  inputTokens: Type.Integer(),
  cacheReadTokens: Type.Integer(),
  cacheCreationTokens: Type.Integer(),
  outputTokens: Type.Integer(),
  costUsd: Nullable(Type.Number()),
})

const SessionDetail = Type.Object({
  session: Session,
  turns: Type.Array(TurnWithCost),
  totalCostUsd: Nullable(Type.Number()),
})

const NotFound = Type.Object({ error: Type.String() })

export function sessionRoutes(app: App) {
  // 세션 목록. 비용은 turns ⨝ model_prices 를 세션별로 SUM 한다.
  app.get(
    '/sessions',
    {
      schema: {
        querystring: Type.Object({ repo: Type.Optional(Type.String()) }),
        response: { 200: Type.Array(SessionSummary) },
      },
    },
    async (req) => {
      const { repo } = req.query

      return db
        .select({
          id: sessions.id,
          repo: sessions.repo,
          gitBranch: sessions.gitBranch,
          startedAt: sessions.startedAt,
          lastSeenAt: sessions.lastSeenAt,
          turns: count(turns.id),
          // 세션 안에서 쓴 모델 목록. array_agg(distinct)는 NULL도 담으므로 걸러낸다.
          models: sql<string[]>`array_remove(array_agg(distinct ${turns.model}), null)`,
          outputTokens: sumInt(turns.outputTokens),
          costUsd: totalCostUsd,
        })
        .from(sessions)
        .leftJoin(turns, eq(turns.sessionId, sessions.id))
        .leftJoin(modelPrices, eq(modelPrices.model, turns.model))
        .where(repo ? eq(sessions.repo, repo) : undefined)
        .groupBy(sessions.id)
        .orderBy(desc(sessions.lastSeenAt))
    },
  )

  // 세션 하나 + 응답 전부(시간순), 응답마다 비용.
  app.get(
    '/sessions/:id',
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: { 200: SessionDetail, 404: NotFound },
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const [session] = await db.select().from(sessions).where(eq(sessions.id, id))
      if (!session) return reply.code(404).send({ error: 'session not found' })

      const rows = await db
        .select({
          id: turns.id,
          ts: turns.ts,
          model: turns.model,
          inputTokens: turns.inputTokens,
          cacheReadTokens: turns.cacheReadTokens,
          cacheCreationTokens: turns.cacheCreationTokens,
          outputTokens: turns.outputTokens,
          costUsd: turnCostUsd.mapWith((v) => (v === null ? null : Number(v))),
        })
        .from(turns)
        .leftJoin(modelPrices, eq(modelPrices.model, turns.model))
        .where(eq(turns.sessionId, id))
        .orderBy(asc(turns.ts))

      const total = rows.reduce<number | null>(
        (acc, t) => (acc === null || t.costUsd === null ? null : acc + t.costUsd),
        0,
      )
      return { session, turns: rows, totalCostUsd: total }
    },
  )
}
