import type { FastifyInstance } from 'fastify'
import { count, countDistinct, desc, eq, max, sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { sessions, turns, skillInvocations, modelPrices, gateEvents } from './db/schema.js'
import { totalCostUsd } from './cost.js'

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
        // 단가표가 DB에 있어서 레포별 비용도 같은 SUM으로 끝난다.
        costUsd: totalCostUsd,
        lastSeenAt: max(sessions.lastSeenAt),
      })
      .from(sessions)
      .leftJoin(turns, eq(turns.sessionId, sessions.id))
      .leftJoin(modelPrices, eq(modelPrices.model, turns.model))
      .groupBy(sessions.repo)
      .orderBy(desc(count(turns.id)))
  })

  // 일별 추세. 최근 N일, 사용 없는 날도 0으로 채워서 돌려준다.
  //
  // 두 가지가 이 쿼리의 핵심이다.
  // 1) 날짜 경계는 한국 시간이다. turns.ts는 UTC라서 그대로 date로 자르면 밤 9시 이후
  //    사용이 다음 날로 넘어간다. AT TIME ZONE 'Asia/Seoul'로 먼저 바꾼 뒤 자른다.
  // 2) generate_series가 날짜 목록을 만들고 거기에 집계를 LEFT JOIN 한다. GROUP BY만
  //    쓰면 사용 없는 날이 행 자체가 없어서 차트에 구멍이 생긴다.
  app.get('/usage/daily', async (req) => {
    const { days: raw } = req.query as { days?: string }
    const days = Math.min(Math.max(Number(raw) || 30, 1), 365)

    const rows = await db.execute<{
      day: string
      sessions: number
      turns: number
      output_tokens: number
      cost_usd: number | null
    }>(sql`
      with days as (
        select generate_series(
          (now() at time zone 'Asia/Seoul')::date - ${days - 1}::int,
          (now() at time zone 'Asia/Seoul')::date,
          interval '1 day'
        )::date as day
      ),
      per_day as (
        select
          (${turns.ts} at time zone 'Asia/Seoul')::date as day,
          count(distinct ${turns.sessionId})::int as sessions,
          count(*)::int as turns,
          coalesce(sum(${turns.outputTokens}), 0)::bigint as output_tokens,
          ${totalCostUsd} as cost_usd
        from ${turns}
        left join ${modelPrices} on ${modelPrices.model} = ${turns.model}
        where (${turns.ts} at time zone 'Asia/Seoul')::date >= (now() at time zone 'Asia/Seoul')::date - ${days - 1}::int
        group by 1
      )
      select
        to_char(days.day, 'YYYY-MM-DD') as day,
        coalesce(per_day.sessions, 0) as sessions,
        coalesce(per_day.turns, 0) as turns,
        coalesce(per_day.output_tokens, 0) as output_tokens,
        coalesce(per_day.cost_usd, 0) as cost_usd
      from days
      left join per_day on per_day.day = days.day
      order by days.day
    `)

    // db.execute는 드라이버가 준 그대로 돌려준다. bigint/numeric은 문자열이라 여기서 숫자로 바꾼다.
    return rows.rows.map((r) => ({
      day: r.day,
      sessions: Number(r.sessions),
      turns: Number(r.turns),
      outputTokens: Number(r.output_tokens),
      costUsd: Number(r.cost_usd),
    }))
  })

  // 게이트 준수. 게이트가 안내를 넣은(nudged) 뒤 같은 세션에서 1시간 안에 suah-judge가
  // 호출됐으면 준수로 본다. 상관 서브쿼리(EXISTS)로 이벤트마다 확인한다.
  // 이벤트 수가 적어(하루 수 건) 지금은 이 방식이 가장 읽기 쉽다.
  app.get('/usage/gates', async () => {
    const complied = sql<boolean>`exists (
      select 1 from ${skillInvocations} si
      where si.session_id = ${gateEvents.sessionId}
        and si.skill = 'suah-judge'
        and si.ts between ${gateEvents.ts} and ${gateEvents.ts} + interval '1 hour'
    )`

    const events = await db
      .select({
        id: gateEvents.id,
        sessionId: gateEvents.sessionId,
        repo: gateEvents.repo,
        ts: gateEvents.ts,
        triggerSkill: gateEvents.triggerSkill,
        outcome: gateEvents.outcome,
        complied,
      })
      .from(gateEvents)
      .orderBy(desc(gateEvents.ts))
      .limit(100)

    const nudged = events.filter((e) => e.outcome === 'nudged')
    const compliedCount = nudged.filter((e) => e.complied).length
    return {
      nudged: nudged.length,
      complied: compliedCount,
      // 분모 0이면 null. 0%로 보이면 "전부 어겼다"로 읽힌다.
      rate: nudged.length ? compliedCount / nudged.length : null,
      events,
    }
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
