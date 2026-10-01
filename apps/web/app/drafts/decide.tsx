'use client'

import { useActionState } from 'react'
import { decide, decideTheme, type DecideState } from './actions'

const initial: DecideState = { error: null, path: null }

// 저장/버리기 버튼 두 개. 누르는 동안 둘 다 막는다 — 한쪽이 도는 중에 다른 쪽을 누르면
// 서버가 409 로 막긴 하지만, 사용자는 두 번째 결과가 왜 실패했는지 알 수 없다.
// 결과는 서버가 목록을 다시 그려 보여준다(상태 열). 여기는 실패 문장만 붙든다.
export function Decide({ messageId }: { messageId: string }) {
  const [accepted, accept, accepting] = useActionState(decide.bind(null, messageId, 'accept'), initial)
  const [rejected, reject, rejecting] = useActionState(decide.bind(null, messageId, 'reject'), initial)
  const busy = accepting || rejecting
  const error = accepted.error ?? rejected.error
  return (
    <>
      <form action={accept} className="inline-form">
        <button className="button is-primary" type="submit" disabled={busy}>
          {accepting ? '쓰는 중…' : '초안으로 저장'}
        </button>
      </form>
      <form action={reject} className="inline-form">
        <button className="button" type="submit" disabled={busy}>
          {rejecting ? '버리는 중…' : '버리기'}
        </button>
      </form>
      {error && <div className="state-error">{error}</div>}
    </>
  )
}

// 취향 규칙 후보용. 버튼 문구만 다르고 동작은 Decide 와 같다.
export function DecideTheme({ id }: { id: number }) {
  const [accepted, accept, accepting] = useActionState(decideTheme.bind(null, id, 'accept'), initial)
  const [rejected, reject, rejecting] = useActionState(decideTheme.bind(null, id, 'reject'), initial)
  const busy = accepting || rejecting
  const error = accepted.error ?? rejected.error
  return (
    <>
      <form action={accept} className="inline-form">
        <button className="button is-primary" type="submit" disabled={busy}>
          {accepting ? '쓰는 중…' : 'inbox 에 추가'}
        </button>
      </form>
      <form action={reject} className="inline-form">
        <button className="button" type="submit" disabled={busy}>
          {rejecting ? '버리는 중…' : '버리기'}
        </button>
      </form>
      {error && <div className="state-error">{error}</div>}
    </>
  )
}
