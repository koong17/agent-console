import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Nav } from '../../nav'
import { SERVER_URL } from '../../server'
import { fmtNum, fmtTime, fmtUsd } from '../../format'

type Turn = {
  id: string
  ts: string
  model: string
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  costUsd: number | null
}

type Detail = {
  session: { id: string; repo: string; cwd: string; gitBranch: string | null; startedAt: string; lastSeenAt: string }
  turns: Turn[]
  totalCostUsd: number | null
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // 404는 에러가 아니라 정상 응답의 하나라 fetchJson(throw) 대신 직접 처리한다.
  const res = await fetch(`${SERVER_URL}/sessions/${id}`, { cache: 'no-store' })
  if (res.status === 404) notFound()
  if (!res.ok) throw new Error(`/sessions/${id} 응답 실패: ${res.status}`)
  const { session, turns, totalCostUsd } = (await res.json()) as Detail

  // 막대 길이 기준. 세션 안에서 가장 비싼 응답을 100%로 둔다.
  const maxCost = Math.max(0, ...turns.map((t) => t.costUsd ?? 0))

  return (
    <main>
      <Nav />
      <h1>
        <Link href={`/sessions?repo=${encodeURIComponent(session.repo)}`}>{session.repo}</Link> ·{' '}
        {session.id.slice(0, 8)}
      </h1>
      <p>
        {session.cwd} · {session.gitBranch ?? '-'} · {session.startedAt.slice(0, 16).replace('T', ' ')} ~{' '}
        {fmtTime(session.lastSeenAt)}
      </p>
      <p>
        응답 {turns.length}개 · API 환산 비용 <strong>{fmtUsd(totalCostUsd)}</strong>
      </p>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #999' }}>
            <th>time</th>
            <th>model</th>
            <th style={{ textAlign: 'right' }}>input</th>
            <th style={{ textAlign: 'right' }}>cache read</th>
            <th style={{ textAlign: 'right' }}>cache write</th>
            <th style={{ textAlign: 'right' }}>output</th>
            <th style={{ textAlign: 'right' }}>cost</th>
            <th style={{ width: 200 }}></th>
          </tr>
        </thead>
        <tbody>
          {turns.map((t) => (
            <tr key={t.id}>
              <td>{fmtTime(t.ts)}</td>
              <td>{t.model.replace('claude-', '')}</td>
              <td style={{ textAlign: 'right' }}>{fmtNum(t.inputTokens)}</td>
              <td style={{ textAlign: 'right' }}>{fmtNum(t.cacheReadTokens)}</td>
              <td style={{ textAlign: 'right' }}>{fmtNum(t.cacheCreationTokens)}</td>
              <td style={{ textAlign: 'right' }}>{fmtNum(t.outputTokens)}</td>
              <td style={{ textAlign: 'right' }}>{fmtUsd(t.costUsd)}</td>
              <td>
                <div
                  style={{
                    height: 10,
                    width: maxCost ? `${((t.costUsd ?? 0) / maxCost) * 100}%` : 0,
                    background: 'steelblue',
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
