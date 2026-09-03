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
      <h1>sessions{repo ? ` · ${repo}` : ''}</h1>
      <p>
        {list.length}개 세션 · API 환산 비용 합계 {fmtUsd(total)}
        {repo && (
          <>
            {' · '}
            <Link href="/sessions">전체 보기</Link>
          </>
        )}
      </p>
      {list.length === 0 ? (
        <p>세션이 없어요.</p>
      ) : (
        <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #999' }}>
              <th>last seen</th>
              <th>repo</th>
              <th>branch</th>
              <th>model</th>
              <th style={{ textAlign: 'right' }}>turns</th>
              <th style={{ textAlign: 'right' }}>output tokens</th>
              <th style={{ textAlign: 'right' }}>cost</th>
              <th>session</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td>{fmtDay(s.lastSeenAt)}</td>
                <td>{s.repo}</td>
                <td>{s.gitBranch ?? '-'}</td>
                <td>{s.models.map((m) => m.replace('claude-', '')).join(', ') || '-'}</td>
                <td style={{ textAlign: 'right' }}>{s.turns}</td>
                <td style={{ textAlign: 'right' }}>{fmtNum(s.outputTokens)}</td>
                <td style={{ textAlign: 'right' }}>{fmtUsd(s.costUsd)}</td>
                <td>
                  <Link href={`/sessions/${s.id}`}>{s.id.slice(0, 8)}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
