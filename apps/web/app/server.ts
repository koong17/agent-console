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

// api.GET 호출 하나를 감싸서, 실패를 항상 "깨끗한" Error(메시지 문자열, cause 없음)로 만든다.
//
// 두 가지 실패가 있다. 둘 다 여기서 같은 모양의 Error로 정규화한다.
//   1) 서버(Fastify)가 살아 있고 5xx/4xx JSON을 줌 → api.GET은 정상 resolve, unwrap이 던진다.
//      (예: Postgres만 죽어 Fastify가 500을 반환. 이 경로는 원래도 잘 동작했다.)
//   2) 서버가 아예 죽어 연결 거부 → api.GET이 네이티브 `TypeError: fetch failed`를 reject한다.
//      이 TypeError는 `cause`(ECONNREFUSED 등)를 달고 오는데, 이 객체를 그대로 페이지 catch로
//      흘려보내면 ErrorState의 error prop이 되어 React 트리에 들어간다. Next 16 dev의 RSC
//      렌더러가 이 native 에러를 직렬화하려다 죽는다(chunk.reason.enqueueModel → frame.join).
//      그래서 여기서 cause의 메시지만 뽑아 새 Error로 다시 던진다. 1)과 같은 깨끗한 모양이 된다.
// 연결 실패(2번)만 깨끗한 Error로 바꿔 던지고, 성공/HTTP 에러 응답은 그대로 돌려준다.
// 404처럼 계약에 있는 응답을 status 로 직접 봐야 하는 곳(세션 상세)이 raw 결과를 받도록 분리했다.
export async function callApi<T extends { response: Response }>(call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (e) {
    const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)
    throw new Error(`서버 연결 실패: ${reason}`)
  }
}

// 대부분의 페이지는 결과를 바로 data로 좁히면 된다. 연결 실패 정규화 + unwrap 을 한 번에.
export async function unwrapAsync<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  return unwrap(await callApi(call))
}
