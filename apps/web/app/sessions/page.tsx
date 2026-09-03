import Link from 'next/link'
import { Nav } from '../nav'
import { fetchJson } from '../server'
import { fmtDay, fmtNum, fmtUsd } from '../format'

type SessionSummary = {
  id: string
  repo: string
  gitBranch: string | null
  startedAt: string
  lastSeenAt: string
  turns: number
  models: string[]
  costUsd: number | null
  outputTokens: number
}

// Next 16: searchParams는 Promise다. 렌더 전에 await 해야 한다.
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string }>
}) {
  const { repo } = await searchParams
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : ''
  const list = await fetchJson<SessionSummary[]>(`/sessions${query}`)
  const total = list.reduce<number | null>(
    (acc, s) => (acc === null || s.costUsd === null ? null : acc + s.costUsd),
    0,
  )

  return (
    <main>
      <Nav />
      <h1>
        sessions{repo && <span className="sub"> · {repo}</span>}
      </h1>
      <p className="summary">
        <strong>{list.length}</strong>개 세션 · API 환산 비용 합계 <strong>{fmtUsd(total)}</strong>
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
                <th>branch</th>
                <th>model</th>
                <th className="num">turns</th>
                <th className="num">output tokens</th>
                <th className="num">cost</th>
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
                  <td className="mono">{s.gitBranch ?? '-'}</td>
                  <td>{s.models.map((m) => m.replace('claude-', '')).join(', ') || '-'}</td>
                  <td className="num">{s.turns}</td>
                  <td className="num">{fmtNum(s.outputTokens)}</td>
                  <td className="num">{fmtUsd(s.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
