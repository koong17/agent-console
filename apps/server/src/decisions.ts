import { Type } from 'typebox'
import { desc, sql } from 'drizzle-orm'
import type { App } from './app.js'
import { db } from './db/index.js'
import { decisions } from './db/schema.js'
import { DateTime, Nullable } from './schemas.js'

// Suah의 결정 기록(/decisions). 에이전트가 선택지를 내밀었을 때 무엇을 골랐고,
// 에이전트의 추천과 얼마나 일치했나.
//
// 동의율의 분모는 "판정 가능한 결정"만이다. agreed가 null인 행(추천이 없었거나 답을 못 읽음)은
// 동의도 반대도 아니라서 분모에 넣으면 비율이 왜곡된다. 그래서 총 개수와 판정 개수를 따로 준다.
// 한계: 이 숫자는 "얼마나 자주 추천을 따랐나"만 말한다. 추천이 옳았는지는 모른다.
// 동의율이 100%에 가까우면 에이전트가 잘 맞추는 것일 수도, Suah가 그냥 따라가는 것일 수도 있다.
// 그 구분은 사람이 반대한 행을 읽어야 한다. 그래서 목록을 같이 준다.

const DecisionRow = Type.Object({
  id: Type.Integer(),
  sessionId: Type.String(),
  repo: Nullable(Type.String()),
  ts: DateTime,
  header: Type.String(),
  question: Type.String(),
  options: Type.Array(Type.String()),
  recommended: Nullable(Type.String()),
  chosen: Nullable(Type.String()),
  agreed: Nullable(Type.Boolean()),
})

const DecisionsReport = Type.Object({
  total: Type.Integer({ description: '기록된 결정 전체' }),
  judged: Type.Integer({ description: '추천이 있고 답도 읽힌 결정. 동의율의 분모' }),
  agreed: Type.Integer(),
  rate: Nullable(Type.Number({ description: 'agreed / judged. judged가 0이면 null' })),
  missingRecommended: Type.Object({
    windowDays: Type.Integer(),
    // 창 안의 결정 수와, 그중 추천이 없었던 수
    total: Type.Integer(),
    missing: Type.Integer(),
    // missing 가운데 복수 선택 질문. 추천 하나가 어울리지 않는 질문이라 따로 센다.
    // 경보는 이걸 뺀 수로 켠다(missing - multiSelect > 0).
    multiSelect: Type.Integer(),
    // 0 이 아니면 켠다. 규칙이 "항상 하나"라서 임계값이 필요 없다.
    alarm: Type.Boolean(),
  }),
  // 최근 것부터. 100개면 한 화면에 충분하고, 그 이상은 기간 필터가 생길 때 다시 본다.
  items: Type.Array(DecisionRow),
})

const LIMIT = 100

// 추천 없는 질문 경보의 창. 최근 이만큼의 날짜만 본다.
//
// 추천 없는 질문은 예측 점수에 못 들어간다. 점수는 "추천이 수아의 답과 맞았나"라서 추천이 없으면
// 채점할 것이 없다. 2026-09-30 기준 209건 중 64건이 이랬다. suah-judge 는 2026-09-29 부터
// "모든 질문은 추천 하나"를 요구한다. 그 규칙이 실제로 지켜지는지 보는 자리다.
//
// 전체 기간이 아니라 창을 쓰는 이유: 규칙이 생기기 전의 64건이 영원히 경보를 켜 두면
// 오늘 새로 어긴 1건이 안 보인다. 7일은 규칙 도입(09-29) 전 기록이 곧 빠져나가는 길이다.
const MISSING_WINDOW_DAYS = 7

export function decisionRoutes(app: App) {
  app.get('/decisions', { schema: { response: { 200: DecisionsReport } } }, async () => {
    // 집계와 목록을 따로 묻는다. 목록은 LIMIT으로 자르지만 비율은 전체를 봐야 하기 때문이다.
    // count(*) filter (where ...)는 Postgres의 조건부 집계. CASE WHEN 합보다 읽기 쉽다.
    const [agg] = await db
      .select({
        total: sql<number>`count(*)::int`,
        judged: sql<number>`count(*) filter (where ${decisions.agreed} is not null)::int`,
        agreed: sql<number>`count(*) filter (where ${decisions.agreed})::int`,
        windowTotal: sql<number>`count(*) filter (where ${decisions.ts} > now() - make_interval(days => ${MISSING_WINDOW_DAYS}))::int`,
        windowMissing: sql<number>`count(*) filter (where ${decisions.ts} > now() - make_interval(days => ${MISSING_WINDOW_DAYS}) and ${decisions.recommended} is null)::int`,
        windowMissingMulti: sql<number>`count(*) filter (where ${decisions.ts} > now() - make_interval(days => ${MISSING_WINDOW_DAYS}) and ${decisions.recommended} is null and ${decisions.multiSelect})::int`,
      })
      .from(decisions)

    const items = await db
      .select({
        id: decisions.id,
        sessionId: decisions.sessionId,
        repo: decisions.repo,
        ts: decisions.ts,
        header: decisions.header,
        question: decisions.question,
        options: decisions.options,
        recommended: decisions.recommended,
        chosen: decisions.chosen,
        agreed: decisions.agreed,
      })
      .from(decisions)
      .orderBy(desc(decisions.ts), desc(decisions.id))
      .limit(LIMIT)

    const total = Number(agg?.total ?? 0)
    const judged = Number(agg?.judged ?? 0)
    const agreedCount = Number(agg?.agreed ?? 0)
    return {
      total,
      judged,
      agreed: agreedCount,
      rate: judged ? agreedCount / judged : null,
      missingRecommended: {
        windowDays: MISSING_WINDOW_DAYS,
        total: Number(agg?.windowTotal ?? 0),
        missing: Number(agg?.windowMissing ?? 0),
        multiSelect: Number(agg?.windowMissingMulti ?? 0),
        alarm: Number(agg?.windowMissing ?? 0) - Number(agg?.windowMissingMulti ?? 0) > 0,
      },
      items,
    }
  })
}
