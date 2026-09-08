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

// openapi-fetch 결과를 data로 좁힌다. 실패면 throw 해서 페이지의 catch가 에러 화면을 그린다.
// 제네릭으로 받는 이유: 결과 타입이 (성공 | 실패) 유니온인데, 에러 응답이 정의되지 않은
// 라우트는 실패 쪽이 never라서 if (res.error) 로 좁히면 never가 된다. 느슨한 형태로 받아 피한다.
export function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
  if (res.error || res.data === undefined) {
    throw new Error(`${new URL(res.response.url).pathname} 응답 실패: ${res.response.status}`)
  }
  return res.data
}
