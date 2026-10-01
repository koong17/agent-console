'use server'

import { revalidatePath } from 'next/cache'
import { api, callApi } from '../server'

export type ChoiceState = { error: string | null }

export async function choose(id: number, choice: 'a' | 'b' | 'tie', _prev: ChoiceState): Promise<ChoiceState> {
  try {
    const res = await callApi(api.POST('/drill/{id}/{choice}', { params: { path: { id, choice } } }))
    // 계약에 오류 응답이 없는 라우트라 res.error 는 never 다. 상태 코드로 본다(audit 과 같다).
    if (!res.response.ok) return { error: `실패 ${res.response.status}` }
    revalidatePath('/drill')
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
