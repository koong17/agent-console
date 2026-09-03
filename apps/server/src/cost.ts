import { sql } from 'drizzle-orm'
import { modelPrices, turns } from './db/schema.js'

// 응답 하나의 USD 비용. turns와 model_prices가 JOIN된 쿼리 안에서만 쓴다.
// 단가 행이 없으면(LEFT JOIN 실패) NULL이 된다. numeric × integer → numeric 이라
// 마지막에 double로 바꿔 JS number로 받는다.
export const turnCostUsd = sql<number | null>`(
  ${turns.inputTokens} * ${modelPrices.inputUsd}
  + (${turns.cacheCreationTokens} - ${turns.cacheCreation1hTokens}) * ${modelPrices.cacheWrite5mUsd}
  + ${turns.cacheCreation1hTokens} * ${modelPrices.cacheWrite1hUsd}
  + ${turns.cacheReadTokens} * ${modelPrices.cacheReadUsd}
  + ${turns.outputTokens} * ${modelPrices.outputUsd}
) / 1000000.0`

// 여러 응답의 비용 합계. 단가 없는 응답이 하나라도 있으면 NULL.
// SUM은 NULL을 조용히 건너뛰어 부분 합계를 돌려주는데, 그건 "덜 쓴 것"처럼 보여 오해를 만든다.
export const totalCostUsd = sql<number | null>`
  case when count(*) filter (where ${turns.id} is not null and ${modelPrices.model} is null) > 0
       then null
       else coalesce(sum(${turnCostUsd}), 0)::double precision
  end`.mapWith((v) => (v === null ? null : Number(v)))
