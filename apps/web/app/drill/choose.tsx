'use client'

import { useActionState } from 'react'
import { choose, type ChoiceState } from './actions'

const initial: ChoiceState = { error: null }

// 세 버튼 모두 같은 무게로 둔다. 어느 하나를 진하게 하면 그쪽으로 기운다.
export function Choose({ id }: { id: number }) {
  const [a, chooseA, pa] = useActionState(choose.bind(null, id, 'a'), initial)
  const [b, chooseB, pb] = useActionState(choose.bind(null, id, 'b'), initial)
  const [t, chooseTie, pt] = useActionState(choose.bind(null, id, 'tie'), initial)
  const busy = pa || pb || pt
  const error = a.error ?? b.error ?? t.error
  return (
    <>
      <form action={chooseA} className="inline-form">
        <button className="button" type="submit" disabled={busy}>
          A 가 나아요
        </button>
      </form>
      <form action={chooseB} className="inline-form">
        <button className="button" type="submit" disabled={busy}>
          B 가 나아요
        </button>
      </form>
      <form action={chooseTie} className="inline-form">
        <button className="button" type="submit" disabled={busy}>
          비슷해요
        </button>
      </form>
      {error && <div className="state-error">{error}</div>}
    </>
  )
}
