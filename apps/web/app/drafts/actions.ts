'use server'

// 서버 액션. 브라우저의 버튼이 이 함수를 부르면 Next 서버가 Fastify 로 POST 를 보낸다.
//
// 브라우저에서 Fastify 를 직접 부르지 않는 이유는 읽기 화면과 같다(milestone 1 결정): CORS 가 필요 없고
// 서버 주소가 브라우저로 나가지 않는다. 이 콘솔의 첫 쓰기 동작이라 그 선을 여기서도 지킨다.
// 끝나면 revalidatePath 로 목록을 다시 그린다 — 서버 컴포넌트는 스스로 다시 돌지 않는다.

import { revalidatePath } from 'next/cache'
import { api, callApi } from '../server'

export type DecideState = { error: string | null; path: string | null }

export async function decide(messageId: string, verb: 'accept' | 'reject', _prev: DecideState): Promise<DecideState> {
  try {
    const opts = { params: { path: { messageId } } }
    const res =
      verb === 'accept'
        ? await callApi(api.POST('/evals/drafts/{messageId}/accept', opts))
        : await callApi(api.POST('/evals/drafts/{messageId}/reject', opts))
    // 409(이미 결정함, 같은 이름의 파일 있음)와 404 는 계약에 있는 응답이라 throw 가 아니라 error 로 온다.
    if (res.error) return { error: res.error.error, path: null }
    revalidatePath('/drafts')
    return { error: null, path: res.data.path }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), path: null }
  }
}
