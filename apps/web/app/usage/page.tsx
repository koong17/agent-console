import Link from 'next/link'
import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtDay, fmtMinute, fmtNum, fmtUsd, fmtBytes } from '../format'
import { DailyChart } from './daily-chart'
import { ErrorState } from '../error-state'

export default async function UsagePage() {
  // 네 요청은 서로 독립이라 동시에 보낸다. 순서대로 await 하면 대기 시간이 합쳐진다.
  let repos: ApiData<'/usage/repos'>
  let skills: ApiData<'/usage/skills/weekly'>
  let daily: ApiData<'/usage/daily'>
  let gates: ApiData<'/usage/gates'>
  let tools: ApiData<'/usage/tools'>
  try {
    ;[repos, skills, daily, gates, tools] = await Promise.all([
      unwrapAsync(api.GET('/usage/repos')),
      unwrapAsync(api.GET('/usage/skills/weekly', { params: { query: { weeks: 8 } } })),
      unwrapAsync(api.GET('/usage/daily', { params: { query: { days: 30 } } })),
      unwrapAsync(api.GET('/usage/gates')),
      unwrapAsync(api.GET('/usage/tools')),
    ])
  } catch (err) {
    return <ErrorState title="usage" error={err} />
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
        레포 <strong>{repos.length}</strong>개 · 스킬 <strong>{skills.rows.length}</strong>개 · API 환산 비용
        합계 <strong>{fmtUsd(totalCost)}</strong>
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
              <br />
              게이트 우회{' '}
              <strong className={gates.bypassed > 0 ? 'status-warning' : undefined}>{gates.bypassed}</strong>
              회 · <span className="mono">{fmtDay(String(gates.bypassedBefore))}</span> 이전 /명령 직접 입력.
              그때는 게이트가 안 잡던 진짜 우회예요. 이후부터는 명령 경로도 게이트가 커버해요.
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
                      <td className="mono">{fmtMinute(e.ts)}</td>
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
        <h2>tool results</h2>
        {/* 세션 상세의 같은 표를 전체 범위로 넓힌 것. 세션 하나만 보면 "이번엔 figma가 91%"까지
            알 수 있지만 그게 습관인지는 모른다. sessions 열이 그걸 답한다 — 1이면 사고, 여럿이면 습관. */}
        <p className="summary">
          도구 <strong>{tools.length}</strong>종 · 합계{' '}
          <strong>{fmtBytes(tools.reduce((a, t) => a + t.bytes, 0))}</strong> · 크기는 바이트다(토큰 아님)
        </p>
        {tools.length === 0 ? (
          <p className="state">아직 도구 응답 기록이 없어요.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>tool</th>
                  <th className="num">calls</th>
                  <th className="num">total</th>
                  <th className="num">avg</th>
                  <th className="num">max</th>
                  <th className="num">sessions</th>
                  <th className="bar-cell"></th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => (
                  <tr key={t.tool}>
                    <td className="mono">{t.tool}</td>
                    <td className="num">{fmtNum(t.calls)}</td>
                    <td className="num">{fmtBytes(t.bytes)}</td>
                    <td className="num">{fmtBytes(t.avgBytes)}</td>
                    <td className="num">{fmtBytes(t.maxBytes)}</td>
                    <td className="num">{fmtNum(t.sessions)}</td>
                    <td className="bar-cell">
                      {/* 가장 큰 도구를 100%로 둔 상대 크기. */}
                      <div className="bar" style={{ width: `${(t.bytes / tools[0]!.bytes) * 100}%` }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>skills · 8w</h2>
        <p className="summary">
          주별 호출 수. 열은 주 시작 월요일. 이번 주{' '}
          <strong>{skills.rows.reduce((a, r) => a + (r.counts.at(-1) ?? 0), 0)}</strong>회 · 지난주{' '}
          <strong>{skills.rows.reduce((a, r) => a + (r.counts.at(-2) ?? 0), 0)}</strong>회
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>skill</th>
                {skills.weeks.map((w) => (
                  <th key={w} className="num">
                    {w.slice(5)}
                  </th>
                ))}
                <th className="num">total</th>
              </tr>
            </thead>
            <tbody>
              {skills.rows.map((r) => (
                <tr key={r.skill}>
                  <td>{r.skill}</td>
                  {r.counts.map((c, i) => (
                    <td key={skills.weeks[i]} className={c === 0 ? 'num cell-zero' : 'num'}>
                      {c === 0 ? '·' : c}
                    </td>
                  ))}
                  <td className="num">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
