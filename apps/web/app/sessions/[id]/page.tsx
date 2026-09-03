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
        <Link href={`/sessions?repo=${encodeURIComponent(session.repo)}`}>{session.repo}</Link>
        <span className="sub"> · {session.id.slice(0, 8)}</span>
      </h1>
      <p className="summary">
        <span className="mono">{session.cwd}</span> · {session.gitBranch ?? '-'} ·{' '}
        <span className="mono">
          {session.startedAt.slice(0, 16).replace('T', ' ')} ~ {fmtTime(session.lastSeenAt)}
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
                  <div className="bar" style={{ width: maxCost ? `${((t.costUsd ?? 0) / maxCost) * 100}%` : 0 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}
