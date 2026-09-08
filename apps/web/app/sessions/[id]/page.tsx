import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Nav } from '../../nav'
import { api, unwrap, type ApiData } from '../../server'
import { fmtMinute, fmtNum, fmtTime, fmtUsd } from '../../format'
import { ErrorState } from '../../error-state'

// Next의 notFound()가 던지는 에러인지 구분한다. digest 필드가 'NEXT_HTTP_ERROR_FALLBACK;404' 로 시작한다.
function isNextNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    String((err as { digest?: string }).digest ?? '').includes('404')
  )
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // 404는 계약에 있는 정상 응답이다. error 쪽 타입이 { error: string } 으로 잡힌다.
  let data: ApiData<'/sessions/{id}'>
  try {
    const res = await api.GET('/sessions/{id}', { params: { path: { id } } })
    if (res.response.status === 404) notFound()
    data = unwrap(res)
  } catch (err) {
    // notFound()는 내부적으로 throw 로 동작한다. 그대로 다시 던져야 Next가 404 페이지를 그린다.
    if (isNextNotFound(err)) throw err
    return <ErrorState title="session" error={err} />
  }
  const { session, turns, totalCostUsd } = data

  // 막대 길이 기준. 세션 안에서 가장 비싼 응답을 100%로 둔다.
  const maxCost = Math.max(0, ...turns.map((t) => t.costUsd ?? 0))

  return (
    <main>
      <Nav />
      <h1>
        <Link href={`/sessions?repo=${encodeURIComponent(session.repo)}`}>{session.repo}</Link>
        <span className="sub"> · {session.id.slice(0, 8)}</span>
      </h1>
      <p className="summary">
        <span className="mono">{session.cwd}</span> · {session.gitBranch ?? '-'} ·{' '}
        <span className="mono">
          {fmtMinute(session.startedAt)} ~ {fmtTime(session.lastSeenAt)}
        </span>
        <br />
        응답 <strong>{turns.length}</strong>개 · API 환산 비용 <strong>{fmtUsd(totalCostUsd)}</strong>
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">time</th>
              <th>model</th>
              <th className="num">input</th>
              <th className="num">cache read</th>
              <th className="num">cache write</th>
              <th className="num">output</th>
              <th className="num">cost</th>
              <th className="bar-cell"></th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t) => (
              <tr key={t.id}>
                <td className="num">{fmtTime(t.ts)}</td>
                <td>{t.model.replace('claude-', '')}</td>
                <td className="num">{fmtNum(t.inputTokens)}</td>
                <td className="num">{fmtNum(t.cacheReadTokens)}</td>
                <td className="num">{fmtNum(t.cacheCreationTokens)}</td>
                <td className="num">{fmtNum(t.outputTokens)}</td>
                <td className="num">{fmtUsd(t.costUsd)}</td>
                <td className="bar-cell">
                  {/* 폭은 데이터에 따라 바뀌므로 인라인. DESIGN.md 7절의 유일한 예외. */}
                  <div
                    className="bar"
                    style={{ width: maxCost ? `${((t.costUsd ?? 0) / maxCost) * 100}%` : 0 }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}
