import { Type } from 'typebox'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { App } from './app.js'
import { db } from './db/index.js'
import { drillPairs, messages } from './db/schema.js'
import { DIMENSIONS } from './jobs/pair-drill.js'

// 쌍 비교 드릴(/drill). 하루 5쌍을 보여주고 수아가 A / B / 비슷함을 고른다.
//
// Elo: 관점마다 값(terse, balanced ...)이 선수다. 처음엔 모두 1500. 한 번 고를 때마다
//   기대 승률 E = 1 / (1 + 10^((상대 - 나) / 400)),  새 점수 = 점수 + K × (결과 - E)
// 결과는 이기면 1, 지면 0, 비슷함이면 0.5. K=32 는 체스에서 흔히 쓰는 값으로, 표본이 적을 때 빨리 움직인다.
// 점수는 저장하지 않는다. 고른 기록을 시간순으로 다시 돌려 매번 계산한다 — 기록이 원본이고 점수는 파생값이다.
// 한계: 쌍마다 원문이 달라서, "이 원문에선 짧은 게 나았다"가 섞인다. 표본이 쌓여야 관점의 선호로 읽힌다.

const DAILY = 5
const K = 32
const START = 1500

const Pair = Type.Object({ id: Type.Integer(), dimension: Type.String(), textA: Type.String(), textB: Type.String(), original: Type.String() })
const Rating = Type.Object({ dimension: Type.String(), style: Type.String(), rating: Type.Integer(), games: Type.Integer() })
const Report = Type.Object({ decided: Type.Integer(), pending: Type.Integer(), today: Type.Array(Pair), ratings: Type.Array(Rating) })
const Params = Type.Object({ id: Type.Integer(), choice: Type.Union([Type.Literal('a'), Type.Literal('b'), Type.Literal('tie')]) })

export function elo(games: Array<{ dimension: string; styleA: string; styleB: string; choice: 'a' | 'b' | 'tie' }>) {
  const r = new Map<string, { rating: number; games: number }>()
  for (const [dim, styles] of Object.entries(DIMENSIONS)) for (const s of Object.keys(styles)) r.set(`${dim}\u0000${s}`, { rating: START, games: 0 })
  for (const g of games) {
    const a = r.get(`${g.dimension}\u0000${g.styleA}`)
    const b = r.get(`${g.dimension}\u0000${g.styleB}`)
    if (!a || !b) continue // 목록에서 빠진 관점·값의 옛 기록
    const ea = 1 / (1 + 10 ** ((b.rating - a.rating) / 400))
    const sa = g.choice === 'a' ? 1 : g.choice === 'b' ? 0 : 0.5
    a.rating += K * (sa - ea)
    b.rating += K * (1 - sa - (1 - ea))
    a.games++
    b.games++
  }
  return [...r].map(([k, v]) => {
    const [dimension, style] = k.split('\u0000')
    return { dimension: dimension!, style: style!, rating: Math.round(v.rating), games: v.games }
  })
}

export function drillRoutes(app: App) {
  app.get('/drill', { schema: { response: { 200: Report } } }, async () => {
    const decidedRows = await db
      .select({ dimension: drillPairs.dimension, styleA: drillPairs.styleA, styleB: drillPairs.styleB, choice: drillPairs.choice })
      .from(drillPairs)
      .where(sql`${drillPairs.choice} is not null`)
      .orderBy(drillPairs.decidedAt, drillPairs.id)
    const [agg] = await db.select({ pending: sql<number>`count(*) filter (where ${drillPairs.choice} is null)::int` }).from(drillPairs)
    // 어느 쪽이 어떤 문체인지는 보여주지 않는다. 이름표를 보면 문체 이름으로 고르게 된다.
    const today = await db
      .select({ id: drillPairs.id, dimension: drillPairs.dimension, textA: drillPairs.textA, textB: drillPairs.textB, original: messages.text })
      .from(drillPairs)
      .innerJoin(messages, eq(messages.id, drillPairs.sourceMessageId))
      .where(isNull(drillPairs.choice))
      .orderBy(sql`md5(${drillPairs.id}::text || current_date::text)`)
      .limit(DAILY)
    return {
      decided: decidedRows.length,
      pending: Number(agg?.pending ?? 0),
      today,
      ratings: elo(decidedRows as Array<{ dimension: string; styleA: string; styleB: string; choice: 'a' | 'b' | 'tie' }>),
    }
  })

  app.post('/drill/:id/:choice', { schema: { params: Params, response: { 200: Type.Object({ ok: Type.Boolean() }) } } }, async (req) => {
    const rows = await db
      .update(drillPairs)
      .set({ choice: req.params.choice, decidedAt: new Date() })
      .where(and(eq(drillPairs.id, req.params.id), isNull(drillPairs.choice)))
      .returning({ id: drillPairs.id })
    return { ok: rows.length === 1 }
  })
}
