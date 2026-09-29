// 초기 데이터. 실행: pnpm db:seed
// 있으면 갱신, 없으면 삽입이라 여러 번 돌려도 된다.
import { sql } from 'drizzle-orm'
import { db, pool } from './index.js'
import { modelPrices } from './schema.js'

// 공식 문서 2026-09-29 확인(기존 행 전부 대조, 값 변화 없음). 단가는 USD / 100만 토큰.
const verifiedAt = new Date('2026-09-29T00:00:00Z')
const rows = [
  ['claude-fable-5-1', 10, 12.5, 20, 0.25, 50],
  ['claude-fable-5', 10, 12.5, 20, 1, 50],
  // 캐시 읽기가 입력의 0.05배다(표준은 0.1배). Fable 5.1 의 0.025배와 함께, 캐시 읽기를
  // "입력 × 0.1" 로 계산하면 안 되는 이유다 — 그래서 단가를 열로 따로 둔다.
  ['claude-opus-5-5', 4, 5, 8, 0.2, 20],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-7', 5, 6.25, 10, 0.5, 25],
  // 아직 우리 데이터에 안 나타난 현행 모델. 같은 문서에서 같이 확인했으므로 미리 넣는다 —
  // 하나라도 단가가 없으면 화면 전체 합계가 null 이 되므로, 공짜 보험이다.
  ['claude-opus-4-6', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-5', 5, 6.25, 10, 0.5, 25],
  ['claude-sonnet-5-5', 2, 2.5, 4, 0.2, 10],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
  ['claude-sonnet-4-6', 3, 3.75, 6, 0.3, 15],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5],
  // 서브에이전트(Explore 등)는 날짜가 붙은 모델 ID로 기록된다. 단가표는 정확히 일치로 JOIN 하므로
  // 날짜 붙은 ID도 행으로 둔다. 새 ID가 나오면 /usage/repos 비용이 null로 떠서 알 수 있다.
  ['claude-haiku-4-5-20251001', 1, 1.25, 2, 0.1, 5],
].map(([model, input, w5m, w1h, read, output]) => ({
  model: String(model),
  inputUsd: String(input),
  cacheWrite5mUsd: String(w5m),
  cacheWrite1hUsd: String(w1h),
  cacheReadUsd: String(read),
  outputUsd: String(output),
  verifiedAt,
}))

try {
  await db
    .insert(modelPrices)
    .values(rows)
    .onConflictDoUpdate({
      target: modelPrices.model,
      // excluded = 지금 넣으려던 값. "새 값으로 덮어써라"를 열마다 쓰지 않아도 된다.
      set: {
        inputUsd: sql`excluded.input_usd`,
        cacheWrite5mUsd: sql`excluded.cache_write_5m_usd`,
        cacheWrite1hUsd: sql`excluded.cache_write_1h_usd`,
        cacheReadUsd: sql`excluded.cache_read_usd`,
        outputUsd: sql`excluded.output_usd`,
        verifiedAt: sql`excluded.verified_at`,
      },
    })
  console.log(`model_prices: ${rows.length} rows upserted`)
} finally {
  await pool.end()
}
