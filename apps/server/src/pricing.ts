// Claude API 공식 단가 (USD / 100만 토큰). 출처: platform.claude.com/docs/en/about-claude/pricing
// 확인일 2026-09-03. 단가가 바뀌면 이 표만 고친다.
//
// Claude Code 구독(정액)으로 쓴 세션은 실제로 이 돈이 청구되지 않는다. 여기서 계산하는 값은
// "API로 같은 양을 썼다면"의 환산 비용이다. 화면에도 그렇게 표기한다.

type Price = {
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  output: number
}

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  'claude-fable-5': { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  'claude-opus-5': { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  'claude-opus-4-8': { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  'claude-opus-4-7': { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  'claude-sonnet-5': { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  'claude-sonnet-4-6': { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  'claude-haiku-4-5': { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
}

export type TokenCounts = {
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheCreation1hTokens: number
  outputTokens: number
}

// 단가를 모르는 모델이면 null. 0으로 치면 "공짜"로 보여 오해를 만든다.
export function costUsd(model: string, t: TokenCounts): number | null {
  // transcript의 model은 "claude-opus-4-8-20260101"처럼 날짜가 붙을 수 있어 앞부분만 맞춘다.
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`))
  if (!key) return null
  const p = PRICES[key]!
  const cache5m = t.cacheCreationTokens - t.cacheCreation1hTokens
  const usd =
    t.inputTokens * p.input +
    cache5m * p.cacheWrite5m +
    t.cacheCreation1hTokens * p.cacheWrite1h +
    t.cacheReadTokens * p.cacheRead +
    t.outputTokens * p.output
  return usd / 1_000_000
}
