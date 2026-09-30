import { Type } from 'typebox'
import { sql } from 'drizzle-orm'
import type { App } from './app.js'
import { db } from './db/index.js'
import { messages, toolResults } from './db/schema.js'

// 대체 로드맵의 점수판(/scoreboard). 브레인이 수아를 얼마나 대신하고 있나를 숫자로 본다.
//
// 첫 항목은 "수아 분": 에이전트가 수아를 기다리게 만든 시간. 두 갈래로 잰다.
//   reply    에이전트가 말을 멈춘 뒤(글) 수아가 다음 메시지를 치기까지. messages.replyTo 로 짝을 짓는다.
//   question 에이전트가 질문(AskUserQuestion)을 띄운 뒤 수아가 답하기까지. tool_results 의 ts - calledAt.
//
// 합계가 아니라 중앙값과 p90 을 낸다. 수아가 점심을 먹으러 가면 한 간격이 몇 시간이 된다.
// 합계는 그런 간격 몇 개가 전부를 차지해서 "기다리게 한 시간"이 아니라 "자리를 비운 시간"이 된다.
// 몇 분 넘으면 자리 비움으로 치는 식의 잘라내기 기준은 근거가 없어서 두지 않았다.
// 중앙값은 그런 간격에 흔들리지 않고, p90 은 그 꼬리가 얼마나 긴지를 따로 보여준다.
//
// reply 쪽의 한계: 에이전트가 말을 멈춘 시각을 "마지막 글 블록의 시각"으로 본다. 글을 쓴 뒤
// 도구를 더 부르고 끝난 턴이면 실제 멈춘 시각보다 이르게 잡혀 간격이 길어진다.

const DAYS = 30

const Latency = Type.Object({
  n: Type.Integer(),
  // 초. n 이 0 이면 null.
  p50: Type.Union([Type.Number(), Type.Null()]),
  p90: Type.Union([Type.Number(), Type.Null()]),
})

const Minutes = Type.Object({
  days: Type.Integer(),
  total: Type.Object({ reply: Latency, question: Latency }),
  // 최근 날짜부터. 기록이 있는 날만.
  byDay: Type.Array(Type.Object({ day: Type.String(), reply: Latency, question: Latency })),
})

type Row = { day: string | null; kind: 'reply' | 'question'; n: number; p50: number | null; p90: number | null }

export function scoreboardRoutes(app: App) {
  app.get('/scoreboard/minutes', { schema: { response: { 200: Minutes } } }, async () => {
    // 두 갈래를 한 목록(gaps)으로 합친 뒤 날짜별·전체를 grouping sets 로 한 번에 낸다.
    // grouping sets ((day, kind), (kind)) 는 GROUP BY 두 번을 한 문장으로 한 것이다.
    // 두 번째 묶음에서는 day 가 null 로 나오고, 그게 "전체" 줄이다.
    const result = await db.execute<Row>(sql`
      with gaps as (
        select 'reply' as kind, m.ts, extract(epoch from m.ts - a.ts) as s
        from ${messages} m join ${messages} a on a.id = m.reply_to
        where m.kind = 'typed' and m.ts >= a.ts
        union all
        select 'question', ${toolResults.ts}, extract(epoch from ${toolResults.ts} - ${toolResults.calledAt})
        from ${toolResults}
        where ${toolResults.tool} = 'AskUserQuestion' and ${toolResults.calledAt} is not null
          and ${toolResults.ts} >= ${toolResults.calledAt}
      )
      select
        to_char(ts::date, 'YYYY-MM-DD') as day, kind, count(*)::int as n,
        percentile_cont(0.5) within group (order by s) as p50,
        percentile_cont(0.9) within group (order by s) as p90
      from gaps
      where ts > now() - make_interval(days => ${DAYS})
      group by grouping sets ((ts::date, kind), (kind))
    `)

    type L = { n: number; p50: number | null; p90: number | null }
    const empty = (): L => ({ n: 0, p50: null, p90: null })
    const pick = (r: Row): L => ({ n: Number(r.n), p50: r.p50 === null ? null : Number(r.p50), p90: r.p90 === null ? null : Number(r.p90) })
    const total = { reply: empty(), question: empty() }
    const days = new Map<string, { day: string; reply: L; question: L }>()
    for (const r of result.rows) {
      if (r.day === null) {
        total[r.kind] = pick(r)
        continue
      }
      const d = days.get(r.day) ?? { day: r.day, reply: empty(), question: empty() }
      d[r.kind] = pick(r)
      days.set(r.day, d)
    }
    return { days: DAYS, total, byDay: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)) }
  })
}
