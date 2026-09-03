import type { FastifyInstance } from 'fastify'
import { asc, count, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { sessions, turns } from './db/schema.js'
import { costUsd, type TokenCounts } from './pricing.js'

const sumInt = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::bigint`.mapWith(Number)

// 세션 목록. 비용은 모델별 단가가 달라서 SQL에서 한 번에 못 더한다.
// (세션, 모델)로 묶어 토큰을 합친 뒤 JS에서 단가를 곱하고 세션별로 다시 모은다.
export function sessionRoutes(app: FastifyInstance) {
  app.get('/sessions', async (req) => {
    const { repo } = req.query as { repo?: string }

    const rows = await db
      .select({
        id: sessions.id,
        repo: sessions.repo,
        gitBranch: sessions.gitBranch,
        startedAt: sessions.startedAt,
        lastSeenAt: sessions.lastSeenAt,
        model: turns.model,
        turns: count(turns.id),
        inputTokens: sumInt(turns.inputTokens),
        cacheReadTokens: sumInt(turns.cacheReadTokens),
        cacheCreationTokens: sumInt(turns.cacheCreationTokens),
        cacheCreation1hTokens: sumInt(turns.cacheCreation1hTokens),
        outputTokens: sumInt(turns.outputTokens),
      })
      .from(sessions)
      .leftJoin(turns, eq(turns.sessionId, sessions.id))
      .where(repo ? eq(sessions.repo, repo) : undefined)
      .groupBy(sessions.id, turns.model)
      .orderBy(desc(sessions.lastSeenAt))

    type Row = (typeof rows)[number]
    type SessionSummary = Omit<Row, 'model' | 'turns'> & {
      turns: number
      models: string[]
      // 단가 모르는 모델이 하나라도 섞이면 null (부분 합계는 오해를 만든다)
      costUsd: number | null
    }

    const bySession = new Map<string, SessionSummary>()
    for (const r of rows) {
      const cur = bySession.get(r.id) ?? {
        id: r.id, repo: r.repo, gitBranch: r.gitBranch, startedAt: r.startedAt, lastSeenAt: r.lastSeenAt,
        turns: 0, models: [], costUsd: 0,
        inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, outputTokens: 0,
      }
      cur.turns += r.turns
      cur.inputTokens += r.inputTokens
      cur.cacheReadTokens += r.cacheReadTokens
      cur.cacheCreationTokens += r.cacheCreationTokens
      cur.cacheCreation1hTokens += r.cacheCreation1hTokens
      cur.outputTokens += r.outputTokens
      if (r.model) {
        cur.models.push(r.model)
        const c = costUsd(r.model, r)
        cur.costUsd = c === null || cur.costUsd === null ? null : cur.costUsd + c
      }
      bySession.set(r.id, cur)
    }
    return [...bySession.values()]
  })

  // 세션 하나 + 응답 전부(시간순). 응답마다 비용을 붙인다.
  app.get('/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [session] = await db.select().from(sessions).where(eq(sessions.id, id))
    if (!session) return reply.code(404).send({ error: 'session not found' })

    const rows = await db
      .select()
      .from(turns)
      .where(eq(turns.sessionId, id))
      .orderBy(asc(turns.ts))

    const withCost = rows.map((t) => ({ ...t, costUsd: costUsd(t.model, t satisfies TokenCounts) }))
    const total = withCost.reduce<number | null>(
      (acc, t) => (acc === null || t.costUsd === null ? null : acc + t.costUsd),
      0,
    )
    return { session, turns: withCost, totalCostUsd: total }
  })
}
