'use client'

import { useActionState } from 'react'
import { judge, type VerdictState } from './actions'

const initial: VerdictState = { error: null }

// 두 버튼 모두 판정을 쓰는 동작이라 어느 쪽도 is-primary 로 앞세우지 않는다 — 한쪽을 강조하면 그쪽으로 기운다.
export function Judge({ id }: { id: number }) {
  const [agreed, agree, agreeing] = useActionState(judge.bind(null, id, 'agree'), initial)
  const [disagreed, disagree, disagreeing] = useActionState(judge.bind(null, id, 'disagree'), initial)
  const busy = agreeing || disagreeing
  const error = agreed.error ?? disagreed.error
  return (
    <>
      <form action={agree} className="inline-form">
        <button className="button" type="submit" disabled={busy}>
          맞아요
        </button>
      </form>
      <form action={disagree} className="inline-form">
        <button className="button" type="submit" disabled={busy}>
          다르게 했을 것
        </button>
      </form>
      {error && <div className="state-error">{error}</div>}
    </>
  )
}
