import { Type } from 'typebox'
import type { App } from './app.js'
import { DateTime, Nullable } from './schemas.js'
import { count, desc, eq, max, sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { sessions, turns, skillInvocations, modelPrices, gateEvents } from './db/schema.js'
import { totalCostUsd } from './cost.js'

// 주어진 시각이 속한 주의 월요일(한국 시간)을 "YYYY-MM-DD 00:00Z" Date로 돌려준다.
// UTC 자정으로 맞춰두면 toISOString().slice(0, 10)이 그대로 날짜 문자열이 된다.
function mondayOf(at: Date): Date {
  const kst = new Date(at.getTime() + 9 * 60 * 60 * 1000)
  const day = kst.getUTCDay() // 0 = 일요일
  const diffToMonday = (day + 6) % 7
  const monday = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - diffToMonday))
  return monday
}

const sumInt = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::bigint`.mapWith(Number)

// 대시보드 첫 화면용 집계 두 개. 두 쿼리 모두 GROUP BY 하나짜리 단순 집계다.
// 행 수(turns 1만)에서는 인덱스 없이도 빠르다. 느려지기 시작하면 /traces에 먼저 보인다.

const RepoUsage = Type.Object({
  repo: Type.String(),
  sessions: Type.Integer(),
  turns: Type.Integer(),
  inputTokens: Type.Integer(),
  outputTokens: Type.Integer(),
  costUsd: Nullable(Type.Number()),
  lastSeenAt: Nullable(DateTime),
})

const DailyUsage = Type.Object({
  day: Type.String({ description: 'YYYY-MM-DD, Asia/Seoul' }),
  sessions: Type.Integer(),
  turns: Type.Integer(),
  outputTokens: Type.Integer(),
  costUsd: Type.Number(),
})

const GateEvent = Type.Object({
  id: Type.Integer(),
  sessionId: Type.String(),
  repo: Nullable(Type.String()),
  ts: DateTime,
  triggerSkill: Type.String(),
  outcome: Type.Union([Type.Literal('nudged'), Type.Literal('throttled')]),
  complied: Type.Boolean(),
})

const GateUsage = Type.Object({
  nudged: Type.Integer(),
  complied: Type.Integer(),
  rate: Nullable(Type.Number({ description: '0..1, nudged가 0이면 null' })),
  events: Type.Array(GateEvent),
})

const SkillWeekly = Type.Object({
  weeks: Type.Array(Type.String({ description: '주 시작 월요일, YYYY-MM-DD, Asia/Seoul' })),
  rows: Type.Array(
    Type.Object({
      skill: Type.String(),
      counts: Type.Array(Type.Integer(), { description: 'weeks와 같은 길이, 같은 순서' }),
      total: Type.Integer(),
    }),
  ),
})

export function usageRoutes(app: App) {
  // 레포별: 세션 수, 응답 수, 토큰, 비용.
  //
  // 세션별로 먼저 뭉친 뒤(서브쿼리 a) 레포로 다시 뭉친다. sessions에 turns를 바로 붙이면
  // 세션 수를 count(distinct)로 세야 하고, Postgres는 distinct 집계가 있으면 해시 집계를
  // 못 써 1만 행을 정렬한다(EXPLAIN ANALYZE 2026-09-08: 약 16ms → 8ms, 비용 계산 포함). 세션별로 뭉치면
  // 세션은 이미 유일해서 count(*)로 충분하다.
  app.get('/usage/repos', { schema: { response: { 200: Type.Array(RepoUsage) } } }, async () => {
    const perSession = db
      .select({
        sessionId: turns.sessionId,
        turns: count().as('turns'),
        inputTokens: sumInt(
          sql`${turns.inputTokens} + ${turns.cacheReadTokens} + ${turns.cacheCreationTokens}`,
        ).as('input_tokens'),
        outputTokens: sumInt(turns.outputTokens).as('output_tokens'),
        costUsd: totalCostUsd.as('cost_usd'),
      })
      .from(turns)
      .leftJoin(modelPrices, eq(modelPrices.model, turns.model))
      .groupBy(turns.sessionId)
      .as('a')

    return db
      .select({
        repo: sessions.repo,
        sessions: count(),
        turns: sumInt(perSession.turns),
        inputTokens: sumInt(perSession.inputTokens),
        outputTokens: sumInt(perSession.outputTokens),
        // 세션 하나라도 단가 미확인(null)이면 레포도 null. 응답이 없는 세션(a 없음)은 0으로 친다.
        costUsd: sql<number | null>`
          case when bool_or(${perSession.costUsd} is null and ${perSession.turns} is not null) then null
               else coalesce(sum(${perSession.costUsd}), 0)::double precision end`.mapWith((v) =>
          v === null ? null : Number(v),
        ),
        lastSeenAt: max(sessions.lastSeenAt),
      })
      .from(sessions)
      .leftJoin(perSession, eq(perSession.sessionId, sessions.id))
      .groupBy(sessions.repo)
      .orderBy(desc(sumInt(perSession.turns)))
  })

  // 일별 추세. 최근 N일, 사용 없는 날도 0으로 채워서 돌려준다.
  //
  // 두 가지가 이 쿼리의 핵심이다.
  // 1) 날짜 경계는 한국 시간이다. turns.ts는 UTC라서 그대로 date로 자르면 밤 9시 이후
  //    사용이 다음 날로 넘어간다. AT TIME ZONE 'Asia/Seoul'로 먼저 바꾼 뒤 자른다.
  // 2) generate_series가 날짜 목록을 만들고 거기에 집계를 LEFT JOIN 한다. GROUP BY만
  //    쓰면 사용 없는 날이 행 자체가 없어서 차트에 구멍이 생긴다.
  app.get(
    '/usage/daily',
    {
      schema: {
        querystring: Type.Object({
          days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365, default: 30 })),
        }),
        response: { 200: Type.Array(DailyUsage) },
      },
    },
    async (req) => {
      const days = req.query.days ?? 30

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
    },
  )

  // 게이트 준수. 게이트가 안내를 넣은(nudged) 뒤 같은 세션에서 1시간 안에 suah-judge가
  // 호출됐으면 준수로 본다. 상관 서브쿼리(EXISTS)로 이벤트마다 확인한다.
  // 이벤트 수가 적어(하루 수 건) 지금은 이 방식이 가장 읽기 쉽다.
  app.get('/usage/gates', { schema: { response: { 200: GateUsage } } }, async () => {
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

  // 스킬별 주간 추세. 최근 N주, 주 시작은 월요일(Postgres date_trunc('week')의 기본), 한국 시간.
  //
  // 결과는 화면이 바로 표로 그릴 수 있게 서버에서 피벗한다:
  //   weeks: ['2026-07-20', ..., '2026-09-07']          ← 열 (빈 주도 포함)
  //   rows:  [{ skill, counts: [0, 3, ..., 5], total }]  ← 행, total 내림차순
  // SQL은 (주, 스킬, 횟수)의 긴 형태로 받고 JS에서 접는다. SQL 피벗(crosstab)은 열 수가
  // 고정이어야 해서 "최근 N주"처럼 변하는 축에 맞지 않는다.
  app.get(
    '/usage/skills/weekly',
    {
      schema: {
        querystring: Type.Object({
          weeks: Type.Optional(Type.Integer({ minimum: 1, maximum: 52, default: 8 })),
        }),
        response: { 200: SkillWeekly },
      },
    },
    async (req) => {
      const weeks = req.query.weeks ?? 8

      // 이번 주 월요일(한국 시간)에서 (weeks - 1)주 전 월요일까지.
      const rows = await db.execute<{ week: string; skill: string; invocations: number }>(sql`
        with bounds as (
          select date_trunc('week', (now() at time zone 'Asia/Seoul'))::date
                 - ((${weeks}::int - 1) * 7) as first_week
        )
        select
          to_char(date_trunc('week', ${skillInvocations.ts} at time zone 'Asia/Seoul'), 'YYYY-MM-DD') as week,
          ${skillInvocations.skill} as skill,
          count(*)::int as invocations
        from ${skillInvocations}, bounds
        where (${skillInvocations.ts} at time zone 'Asia/Seoul')::date >= bounds.first_week
        group by 1, 2
      `)

      // 열: 최근 N주의 월요일 목록. 사용 없는 주도 자리를 차지해야 추세가 끊기지 않는다.
      const thisMonday = mondayOf(new Date())
      const weekKeys: string[] = []
      for (let i = weeks - 1; i >= 0; i--) {
        const d = new Date(thisMonday)
        d.setUTCDate(d.getUTCDate() - i * 7)
        weekKeys.push(d.toISOString().slice(0, 10))
      }
      const col = new Map(weekKeys.map((w, i) => [w, i]))

      const bySkill = new Map<string, number[]>()
      for (const r of rows.rows) {
        const i = col.get(r.week)
        if (i === undefined) continue // 경계 밖(시간대 반올림 등)은 버린다
        const counts = bySkill.get(r.skill) ?? new Array<number>(weeks).fill(0)
        counts[i] = Number(r.invocations)
        bySkill.set(r.skill, counts)
      }

      const result = [...bySkill.entries()]
        .map(([skill, counts]) => ({ skill, counts, total: counts.reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.total - a.total)

      return { weeks: weekKeys, rows: result }
    },
  )
}
