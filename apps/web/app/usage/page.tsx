import Link from 'next/link'
import { Nav } from '../nav'
import { fetchJson } from '../server'
import { fmtDay, fmtNum, fmtUsd } from '../format'

type RepoUsage = {
  repo: string
  sessions: number
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  lastSeenAt: string | null
}

type SkillUsage = {
  skill: string
  invocations: number
  lastUsedAt: string
}

export default async function UsagePage() {
  // 두 요청은 서로 독립이라 동시에 보낸다. 순서대로 await 하면 대기 시간이 합쳐진다.
  let repos: RepoUsage[]
  let skills: SkillUsage[]
  try {
    ;[repos, skills] = await Promise.all([
      fetchJson<RepoUsage[]>('/usage/repos'),
      fetchJson<SkillUsage[]>('/usage/skills'),
    ])
  } catch (err) {
    return (
      <main>
        <Nav />
        <h1>usage</h1>
        <p className="state-error">서버에서 데이터를 못 받았어요. Fastify(4000)가 켜져 있는지 확인하세요.</p>
        <pre>{err instanceof Error ? err.message : String(err)}</pre>
      </main>
    )
  }

  if (repos.length === 0) {
    return (
      <main>
        <Nav />
        <h1>usage</h1>
        <p className="state">
          아직 데이터가 없어요. 서버 폴더에서 <code>pnpm ingest:transcripts</code> 를 실행하세요.
        </p>
      </main>
    )
  }

  const totalCost = repos.reduce<number | null>(
    (acc, r) => (acc === null || r.costUsd === null ? null : acc + r.costUsd),
    0,
  )

  return (
    <main>
      <Nav />
      <h1>usage</h1>
      <p className="summary">
        레포 <strong>{repos.length}</strong>개 · 스킬 <strong>{skills.length}</strong>개 · API 환산 비용 합계{' '}
        <strong>{fmtUsd(totalCost)}</strong>
      </p>

      <section>
        <h2>repos</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>repo</th>
                <th className="num">sessions</th>
                <th className="num">turns</th>
                <th className="num">input tokens</th>
                <th className="num">output tokens</th>
                <th className="num">cost</th>
                <th>last seen</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.repo}>
                  <td>
                    <Link href={`/sessions?repo=${encodeURIComponent(r.repo)}`}>{r.repo}</Link>
                  </td>
                  <td className="num">{r.sessions}</td>
                  <td className="num">{fmtNum(r.turns)}</td>
                  <td className="num">{fmtNum(r.inputTokens)}</td>
                  <td className="num">{fmtNum(r.outputTokens)}</td>
                  <td className="num">{fmtUsd(r.costUsd)}</td>
                  <td className="mono">{fmtDay(r.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>skills</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>skill</th>
                <th className="num">invocations</th>
                <th>last used</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.skill}>
                  <td>{s.skill}</td>
                  <td className="num">{s.invocations}</td>
                  <td className="mono">{fmtDay(s.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
