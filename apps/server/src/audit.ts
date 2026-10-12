import { Type } from 'typebox'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { App } from './app.js'
import { db } from './db/index.js'
import { messages, soloDecisions } from './db/schema.js'
import { DateTime } from './schemas.js'

// 혼자 한 결정 감사(/audit/solo). 에이전트가 묻지 않고 정한 결정을 하루 몇 개씩 무작위로 보여주고,
// 수아가 "맞아요 / 다르게 했을 것"으로 답한다. 침묵이 동의였는지를 표본으로 잰다.
//
// 하루 표본은 md5(id || 날짜) 순서다. 같은 날에는 새로고침해도 같은 결정이 나오고(하나 답하면 다음 것이
// 올라온다), 날이 바뀌면 다른 결정이 앞에 온다. random() 을 쓰면 새로고침마다 바뀌어서 답하려던 행이 사라진다.
//
// 빼거나 미루거나 건너뛴 결정을 먼저 보여준다. 2026-10-12 기준 판정 68건 중 반대 9건 가운데 7건이 이 꼴이었고
// (이 꼴 24건 중 7건, 나머지 44건 중 2건), 동의가 87%라 하루 10건은 수아 시간 대비 얻는 게 적었다.
// 이 낱말 목록은 그 9건을 보고 만든 것이라 표본 안 적합이다 — 새 반대가 이 꼴 밖에서 나오면 목록을 다시 본다.
const DAILY = 3
const DEFERRAL = '제외|생략|미루|미뤘|선행|미정의|보관|남겨|않고|않았|대신|보류|빼고|뺐|건너|막았|후속|따로|분리'

const Item = Type.Object({
  id: Type.Integer(),
  ts: DateTime,
  summary: Type.String(),
  alternative: Type.String(),
  // 결정이 적힌 에이전트 글의 앞부분. 결정 문장만으로 판단이 안 될 때 본다.
  context: Type.String(),
})

const Report = Type.Object({
  extracted: Type.Integer({ description: '뽑아 둔 결정 전체' }),
  answered: Type.Integer(),
  agree: Type.Integer(),
  today: Type.Array(Item),
})

const Verdict = Type.Object({ ok: Type.Boolean() })
const Params = Type.Object({ id: Type.Integer(), verdict: Type.Union([Type.Literal('agree'), Type.Literal('disagree')]) })

export function auditRoutes(app: App) {
  app.get('/audit/solo', { schema: { response: { 200: Report } } }, async () => {
    const [agg] = await db
      .select({
        extracted: sql<number>`count(*)::int`,
        answered: sql<number>`count(${soloDecisions.verdict})::int`,
        agree: sql<number>`count(*) filter (where ${soloDecisions.verdict} = 'agree')::int`,
      })
      .from(soloDecisions)
    const today = await db
      .select({
        id: soloDecisions.id,
        ts: messages.ts,
        summary: soloDecisions.summary,
        alternative: soloDecisions.alternative,
        context: sql<string>`left(${messages.text}, 600)`,
      })
      .from(soloDecisions)
      .innerJoin(messages, eq(messages.id, soloDecisions.messageId))
      .where(isNull(soloDecisions.verdict))
      .orderBy(sql`(${soloDecisions.summary} ~ ${DEFERRAL}) desc`, sql`md5(${soloDecisions.id}::text || current_date::text)`)
      .limit(DAILY)
    return {
      extracted: Number(agg?.extracted ?? 0),
      answered: Number(agg?.answered ?? 0),
      agree: Number(agg?.agree ?? 0),
      today,
    }
  })

  // 판정은 한 번만 쓴다. 이미 답한 결정에 다시 누르면 무시한다(두 탭에서 눌러도 첫 답이 남는다).
  app.post('/audit/solo/:id/:verdict', { schema: { params: Params, response: { 200: Verdict } } }, async (req) => {
    const rows = await db
      .update(soloDecisions)
      .set({ verdict: req.params.verdict, decidedAt: new Date() })
      .where(and(eq(soloDecisions.id, req.params.id), isNull(soloDecisions.verdict)))
      .returning({ id: soloDecisions.id })
    return { ok: rows.length === 1 }
  })
}
