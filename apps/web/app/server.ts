// Fastify 서버 호출을 한 곳에 모은다. 페이지마다 URL과 에러 처리를 반복하지 않기 위한 것이고,
// 그 이상(캐시, 재시도)은 필요해질 때 넣는다.
export const SERVER_URL = process.env.SERVER_URL ?? 'http://127.0.0.1:4000'

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} 응답 실패: ${res.status}`)
  return res.json()
}
