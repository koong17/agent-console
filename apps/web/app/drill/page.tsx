import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { ErrorState } from '../error-state'
import { Choose } from './choose'

type Report = ApiData<'/drill'>

const DIM: Record<string, string> = { length: '길이', order: '순서', register: '말투' }

// 쌍 비교 드릴. 같은 내용을 한 관점에서만 다르게 쓴 두 글 중 나은 쪽을 고른다.
// 어느 쪽이 어떤 문체인지는 숨긴다 — 이름표를 보면 글이 아니라 이름으로 고르게 된다.
export default async function DrillPage() {
  let r: Report
  try {
    r = await unwrapAsync(api.GET('/drill'))
  } catch (err) {
    return <ErrorState title="drill" error={err} />
  }
  const dims = [...new Set(r.ratings.map((x) => x.dimension))]

  return (
    <main>
      <Nav />
      <h1>drill</h1>
      {r.decided + r.pending === 0 ? (
        <p className="state">
          아직 쌍이 없어요. <span className="mono">pnpm jobs pair-drill</span> 을 실행하세요.
        </p>
      ) : (
        <>
          <p className="summary">
            고른 쌍 <strong>{r.decided}</strong> · 남은 쌍 <strong>{r.pending}</strong>
            <br />
            수아 님 에이전트가 실제로 쓴 보고 글을, 내용은 그대로 두고 한 관점(길이·순서·말투)만 다르게 두 번 다시 썼어요.
            읽고 싶은 쪽을 고르세요. 하루 5쌍이에요.
          </p>
          <section>
            <h2>today</h2>
            {r.today.length === 0 ? (
              <p className="state">오늘 남은 쌍이 없어요.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>A</th>
                      <th>B</th>
                      <th>choice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.today.map((p) => (
                      <tr key={p.id} className="align-top">
                        <td className="wrap">
                          <pre className="block">{p.textA}</pre>
                          <details>
                            <summary className="cell-zero">원문 보기 · 관점: {DIM[p.dimension] ?? p.dimension}</summary>
                            <pre className="block">{p.original}</pre>
                          </details>
                        </td>
                        <td className="wrap">
                          <pre className="block">{p.textB}</pre>
                        </td>
                        <td className="stack">
                          <Choose id={p.id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <h2>ratings</h2>
            <p className="summary">
              관점마다 문체를 선수로 두고 고른 결과로 Elo 점수를 매겨요(시작 1500). 높을수록 수아 님이 그 문체를 골랐어요.
              판수가 적으면 점수가 크게 흔들려요.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>dimension</th>
                    <th>style</th>
                    <th className="num">rating</th>
                    <th className="num">games</th>
                  </tr>
                </thead>
                <tbody>
                  {dims.flatMap((d) =>
                    r.ratings
                      .filter((x) => x.dimension === d)
                      .sort((a, b) => b.rating - a.rating)
                      .map((x) => (
                        <tr key={`${d}-${x.style}`} className={x.games === 0 ? 'is-faint' : undefined}>
                          <td>{DIM[d] ?? d}</td>
                          <td className="mono">{x.style}</td>
                          <td className="num">{x.rating}</td>
                          <td className="num">{x.games}</td>
                        </tr>
                      )),
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  )
}
