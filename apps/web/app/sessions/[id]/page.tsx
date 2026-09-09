import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Nav } from '../../nav'
import { api, callApi, unwrap, type ApiData } from '../../server'
import { fmtDay, fmtMinute, fmtNum, fmtTime, fmtUsd } from '../../format'
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
    const res = await callApi(api.GET('/sessions/{id}', { params: { path: { id } } }))
    if (res.response.status === 404) notFound()
    data = unwrap(res)
  } catch (err) {
    // notFound()는 내부적으로 throw 로 동작한다. 그대로 다시 던져야 Next가 404 페이지를 그린다.
    if (isNextNotFound(err)) throw err
    return <ErrorState title="session" error={err} />
  }
  const { session, turns, skills, totalCostUsd } = data

  // 막대 길이 기준. 세션 안에서 가장 비싼 응답을 100%로 둔다.
  const maxCost = Math.max(0, ...turns.map((t) => t.costUsd ?? 0))

  // 재개된 세션은 여러 날에 걸친다(예전 대화를 새 파일에 이어 붙인다). 그런 세션에서 시각만
  // 보여주면 07-31 16:52 다음에 08-03 13:24 가 와서 순서가 뒤집혀 보인다. 여러 날에 걸칠 때만
  // 시각 앞에 날짜(MM-DD)를 붙인다. 하루짜리면 DESIGN.md 대로 시각만.
  const spansDays =
    new Set([...turns.map((t) => t.ts), ...skills.map((s) => s.ts)].map((iso) => fmtDay(String(iso))))
      .size > 1
  const stamp = (iso: string) => (spansDays ? `${fmtDay(iso).slice(5)} ${fmtTime(iso)}` : fmtTime(iso))

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
        응답 <strong>{turns.length}</strong>개 · 스킬 <strong>{skills.length}</strong>개 · API 환산 비용{' '}
        <strong>{fmtUsd(totalCostUsd)}</strong>
      </p>

      <section>
        <h2>skills</h2>
        {skills.length === 0 ? (
          <p className="state">이 세션에서 스킬을 부른 기록이 없어요.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">time</th>
                  <th>skill</th>
                  <th>source</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((s) => (
                  <tr key={s.id}>
                    <td className="num">{stamp(String(s.ts))}</td>
                    <td>{s.skill}</td>
                    {/* source: tool = 모델이 Skill 도구로, command = 사용자가 /이름으로 직접 입력.
                        색을 칠하지 않는다(상태가 아니다). 값 자체가 구분을 말한다. */}
                    <td className="mono">{s.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>turns</h2>
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
                  <td className="num">{stamp(String(t.ts))}</td>
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
      </section>
    </main>
  )
}
