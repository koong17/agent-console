import createClient from 'openapi-fetch'
import type { paths } from '@agent-console/contract'

export const SERVER_URL = process.env.SERVER_URL ?? 'http://127.0.0.1:4000'

// 계약(openapi.d.ts)에서 타입을 받는 fetch 클라이언트. 경로, 쿼리, 응답 모양이 전부
// 서버 스키마에서 나온다. 서버가 필드를 바꾸면 여기서 tsc가 깨진다. 그게 목적이다.
export const api = createClient<paths>({ baseUrl: SERVER_URL, cache: 'no-store' })

// 계약에 아직 안 올라간 라우트용. 스키마가 붙는 대로 api.GET으로 옮기고 지운다.
export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} 응답 실패: ${res.status}`)
  return res.json()
}
