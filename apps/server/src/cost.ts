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

// 그 합계 중 "이미 만든 걸 다시 실어 나르는 데" 쓴 몫. 캐시 읽기 비용만 따로 뽑는다.
//
// 왜 이 숫자가 따로 필요한가: 한 턴의 비용은 대부분 새로 만든 것(출력)이 아니라
// 앞선 대화 전체를 다시 읽는 값이다. 대화가 길어질수록 턴마다 같은 컨텍스트를 다시
// 읽으므로, 결과물은 그대로인데 비용만 늘어난다. 2026-09-16 실측에서 어떤 세션은
// 출력에 $24, 운반에 $362를 썼다. 총액만 보면 그 모양이 안 보인다.
//
// 캐시 쓰기는 뺐다. 그건 "다음에 싸게 읽으려고 한 번 내는 값"이라 운반이 아니라 투자다.
// NULL 규칙은 totalCostUsd 와 같다 — 단가 모르는 응답이 섞이면 비중도 못 믿는다.
export const carryCostUsd = sql<number | null>`
  case when count(*) filter (where ${turns.id} is not null and ${modelPrices.model} is null) > 0
       then null
       else coalesce(sum(${turns.cacheReadTokens} * ${modelPrices.cacheReadUsd}), 0)::double precision / 1000000.0
  end`.mapWith((v) => (v === null ? null : Number(v)))
