import type { FastifyInstance } from 'fastify'
import { count, countDistinct, desc, eq, max, sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { sessions, turns, skillInvocations } from './db/schema.js'

// 대시보드 첫 화면용 집계 두 개. 두 쿼리 모두 GROUP BY 하나짜리 단순 집계다.
// 행 수(turns 1만)에서는 인덱스 없이도 빠르다. 느려지기 시작하면 /traces에 먼저 보인다.

export function usageRoutes(app: FastifyInstance) {
  // 레포별: 세션 수, 응답 수, 토큰. LEFT JOIN이라 turn이 없는 세션도 행으로 남는다.
  app.get('/usage/repos', async () => {
    return db
      .select({
        repo: sessions.repo,
        sessions: countDistinct(sessions.id),
        turns: count(turns.id),
        // sum()은 numeric이라 문자열로 온다. 정수 범위 안이므로 bigint로 캐스팅해 숫자로 받는다.
        inputTokens: sql<number>`coalesce(sum(${turns.inputTokens} + ${turns.cacheReadTokens} + ${turns.cacheCreationTokens}), 0)::bigint`.mapWith(Number),
        outputTokens: sql<number>`coalesce(sum(${turns.outputTokens}), 0)::bigint`.mapWith(Number),
        lastSeenAt: max(sessions.lastSeenAt),
      })
      .from(sessions)
      .leftJoin(turns, eq(turns.sessionId, sessions.id))
      .groupBy(sessions.repo)
      .orderBy(desc(count(turns.id)))
  })

  // 스킬별 호출 수와 마지막 사용 시각.
  app.get('/usage/skills', async () => {
    return db
      .select({
        skill: skillInvocations.skill,
        invocations: count(),
        lastUsedAt: max(skillInvocations.ts),
      })
      .from(skillInvocations)
      .groupBy(skillInvocations.skill)
      .orderBy(desc(count()))
  })
}
