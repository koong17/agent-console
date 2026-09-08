import Link from 'next/link'
import { Nav } from '../nav'
import { api, type ApiData } from '../server'
import { fmtDay, fmtNum, fmtUsd } from '../format'
import { DailyChart } from './daily-chart'

// openapi-fetch 결과를 data로 좁힌다. 실패면 throw 해서 아래 catch가 에러 화면을 그린다.
function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
  if (res.error || res.data === undefined)
    throw new Error(`${res.response.url} 응답 실패: ${res.response.status}`)
  return res.data
}

export default async function UsagePage() {
  // 두 요청은 서로 독립이라 동시에 보낸다. 순서대로 await 하면 대기 시간이 합쳐진다.
  // 네 요청은 서로 독립이라 동시에 보낸다. 순서대로 await 하면 대기 시간이 합쳐진다.
  let repos: ApiData<'/usage/repos'>
  let skills: ApiData<'/usage/skills'>
  let daily: ApiData<'/usage/daily'>
  let gates: ApiData<'/usage/gates'>
  try {
    const [r, s, d, g] = await Promise.all([
      api.GET('/usage/repos'),
      api.GET('/usage/skills'),
      api.GET('/usage/daily', { params: { query: { days: 30 } } }),
      api.GET('/usage/gates'),
    ])
    repos = unwrap(r)
    skills = unwrap(s)
    daily = unwrap(d)
    gates = unwrap(g)
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
          아직 데이터가 없어요. 서버 폴더에서 <code>pnpm ingest</code> 를 실행하세요.
        </p>
      </main>
    )
  }

  const totalCost = repos.reduce<number | null>(
    (acc, r) => (acc === null || r.costUsd === null ? null : acc + r.costUsd),
    0,
  )
  const last7 = daily.slice(-7).reduce((a, d) => a + d.costUsd, 0)
  const prev7 = daily.slice(-14, -7).reduce((a, d) => a + d.costUsd, 0)

  return (
    <main>
      <Nav />
      <h1>usage</h1>
      <p className="summary">
        레포 <strong>{repos.length}</strong>개 · 스킬 <strong>{skills.length}</strong>개 · API 환산 비용 합계{' '}
        <strong>{fmtUsd(totalCost)}</strong>
      </p>

      <section>
        <h2>daily · 30d</h2>
        <p className="summary">
          최근 7일 <strong>{fmtUsd(last7)}</strong> · 그 전 7일 <strong>{fmtUsd(prev7)}</strong>
        </p>
        <DailyChart days={daily} />
      </section>

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
        <h2>gate</h2>
        {gates.nudged === 0 ? (
          <p className="state">
            아직 게이트가 울린 기록이 없어요. 판단 스킬(code-review, feature-plan…)을 부르면 쌓여요.
          </p>
        ) : (
          <>
            <p className="summary">
              suah-judge 게이트 준수{' '}
              <strong>{gates.rate === null ? '-' : `${Math.round(gates.rate * 100)}%`}</strong> · 안내{' '}
              <strong>{gates.nudged}</strong>회 중 <strong>{gates.complied}</strong>회 1시간 안에 suah-judge
              호출
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>time</th>
                    <th>repo</th>
                    <th>trigger</th>
                    <th>outcome</th>
                    <th>complied</th>
                    <th>session</th>
                  </tr>
                </thead>
                <tbody>
                  {gates.events.map((e) => (
                    <tr key={e.id} className={e.outcome === 'nudged' && !e.complied ? 'is-error' : undefined}>
                      <td className="mono">{e.ts.slice(0, 16).replace('T', ' ')}</td>
                      <td>{e.repo ?? '-'}</td>
                      <td>{e.triggerSkill}</td>
                      <td>{e.outcome}</td>
                      <td>{e.outcome === 'nudged' ? (e.complied ? 'yes' : 'no') : '-'}</td>
                      <td className="mono">
                        <Link href={`/sessions/${e.sessionId}`}>{e.sessionId.slice(0, 8)}</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
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
