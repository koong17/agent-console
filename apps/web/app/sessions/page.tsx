import Link from 'next/link'
import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtDay, fmtNum, fmtUsd } from '../format'
import { ErrorState } from '../error-state'

// Next 16: searchParams는 Promise다. 렌더 전에 await 해야 한다.
export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  const { repo } = await searchParams
  // repo가 undefined면 openapi-fetch가 쿼리스트링을 아예 붙이지 않는다. 인코딩도 맡긴다.
  let list: ApiData<'/sessions'>
  try {
    list = await unwrapAsync(api.GET('/sessions', { params: { query: { repo } } }))
  } catch (err) {
    return <ErrorState title="sessions" error={err} />
  }
  const total = list.reduce<number | null>(
    (acc, s) => (acc === null || s.costUsd === null ? null : acc + s.costUsd),
    0,
  )
  // 비용 중 캐시 읽기가 차지하는 몫. 대화가 길어질수록 턴마다 같은 컨텍스트를 다시 읽어서
  // 결과물은 그대로인데 비용만 오른다. 그 모양은 총액만 봐서는 안 보인다.
  const carry = list.reduce<number | null>(
    (acc, s) => (acc === null || s.carryUsd === null ? null : acc + s.carryUsd),
    0,
  )
  const carryPct = total && carry !== null ? Math.round((carry / total) * 100) : null

  return (
    <main>
      <Nav />
      <h1>sessions{repo && <span className="sub"> · {repo}</span>}</h1>
      <p className="summary">
        <strong>{list.length}</strong>개 세션 · API 환산 비용 합계 <strong>{fmtUsd(total)}</strong>
        {carryPct !== null && (
          <>
            {' · 그중 컨텍스트 운반 '}
            <strong>{fmtUsd(carry)}</strong> (<strong>{carryPct}%</strong>)
          </>
        )}
        {repo && (
          <>
            {' · '}
            <Link href="/sessions">전체 보기</Link>
          </>
        )}
      </p>
      {list.length === 0 ? (
        <p className="state">세션이 없어요.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>session</th>
                <th>last seen</th>
                <th>repo</th>
                <th>model</th>
                <th className="num">turns</th>
                <th className="num">output tokens</th>
                <th className="num">cost</th>
                <th className="num">carry %</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td className="mono">
                    <Link href={`/sessions/${s.id}`}>{s.id.slice(0, 8)}</Link>
                  </td>
                  <td className="mono">{fmtDay(s.lastSeenAt)}</td>
                  <td>{s.repo}</td>
                  <td>{s.models.map((m) => m.replace('claude-', '')).join(', ') || '-'}</td>
                  <td className="num">{s.turns}</td>
                  <td className="num">{fmtNum(s.outputTokens)}</td>
                  <td className="num">{fmtUsd(s.costUsd)}</td>
                  {/* 비용 중 캐시 읽기 몫. 절대액 대신 비율만 두는 이유는 폭이다 —
                      이 표는 이미 화면보다 넓고, 합계 절대액은 위 요약 줄에 있다. */}
                  <td className="num">
                    {s.costUsd && s.carryUsd !== null
                      ? `${Math.round((s.carryUsd / s.costUsd) * 100)}%`
                      : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
