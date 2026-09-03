import type { FastifyInstance } from 'fastify'
import { asc, count, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { sessions, turns, modelPrices } from './db/schema.js'
import { turnCostUsd, totalCostUsd } from './cost.js'

const sumInt = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::bigint`.mapWith(Number)

export function sessionRoutes(app: FastifyInstance) {
  // 세션 목록. 비용은 turns ⨝ model_prices 를 세션별로 SUM 한다.
  app.get('/sessions', async (req) => {
    const { repo } = req.query as { repo?: string }

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
  })

  // 세션 하나 + 응답 전부(시간순), 응답마다 비용.
  app.get('/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
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
  })
}
