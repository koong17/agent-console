import createClient from 'openapi-fetch'
import type { paths } from '@agent-console/contract'

export const SERVER_URL = process.env.SERVER_URL ?? 'http://127.0.0.1:4000'

// 계약(openapi.d.ts)에서 타입을 받는 fetch 클라이언트. 경로, 쿼리, 응답 모양이 전부
// 서버 스키마에서 나온다. 서버가 필드를 바꾸면 여기서 tsc가 깨진다. 그게 목적이다.
export const api = createClient<paths>({ baseUrl: SERVER_URL, cache: 'no-store' })

// 계약에서 응답 타입을 꺼내는 단축키. 페이지가 타입을 다시 적지 않게 한다.
// 예: ApiData<'/usage/daily'>  →  DailyUsage[]
export type ApiData<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': infer T } } } }
}
  ? T
  : never
