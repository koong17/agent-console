'use server'

// 판정 버튼의 서버 액션. drafts 와 같은 이유로 브라우저가 Fastify 를 직접 부르지 않는다.
import { revalidatePath } from 'next/cache'
import { api, callApi } from '../server'

export type VerdictState = { error: string | null }

export async function judge(id: number, verdict: 'agree' | 'disagree', _prev: VerdictState): Promise<VerdictState> {
  try {
    const res = await callApi(api.POST('/audit/solo/{id}/{verdict}', { params: { path: { id, verdict } } }))
    // 이 라우트는 계약에 오류 응답이 없어서 res.error 의 타입이 never 다. 상태 코드로 본다.
    if (!res.response.ok) return { error: `실패 ${res.response.status}` }
    revalidatePath('/audit')
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
