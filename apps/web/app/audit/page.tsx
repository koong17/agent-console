import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtMinute } from '../format'
import { ErrorState } from '../error-state'
import { Judge } from './judge'

type Report = ApiData<'/audit/solo'>

// 혼자 한 결정 감사. 에이전트가 묻지 않고 정한 결정을 하루 10개씩 보여주고 맞는지 묻는다.
// 예측 점수와 교정은 수아가 말한 곳만 본다. 말하지 않고 지나간 결정이 동의였는지는 여기서만 잰다.
export default async function AuditPage() {
  let r: Report
  try {
    r = await unwrapAsync(api.GET('/audit/solo'))
  } catch (err) {
    return <ErrorState title="audit" error={err} />
  }
  const rate = r.answered ? `${Math.round((r.agree / r.answered) * 100)}%` : '-'

  return (
    <main>
      <Nav />
      <h1>audit</h1>
      {r.extracted === 0 ? (
        <p className="state">
          아직 뽑아 둔 결정이 없어요. <span className="mono">pnpm jobs solo-decision</span> 을 실행하세요.
        </p>
      ) : (
        <>
          <p className="summary">
            답한 결정 <strong>{r.answered}</strong>개 중 맞아요 <strong>{rate}</strong> · 뽑아 둔 결정 <strong>{r.extracted}</strong>개
            <br />
            수아 님이 교정하지 않고 지나간 에이전트 글에서, 묻지 않고 정한 결정을 뽑았어요. 오늘의 10개는 날마다 바뀌고, 하나
            답하면 다음 것이 올라와요. "다르게 했을 것"이 많으면 침묵을 동의로 읽으면 안 된다는 뜻이에요.
          </p>
          {r.today.length === 0 ? (
            <p className="state">남은 결정이 없어요. 전부 답했어요.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>time</th>
                    <th>decision</th>
                    <th>instead of</th>
                    <th>verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {r.today.map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{fmtMinute(String(d.ts)).slice(0, 10)}</td>
                      <td className="wrap">
                        {/* 결정 문장만으로 모를 때를 위해 원문 앞부분을 접어 둔다 */}
                        <details>
                          <summary>{d.summary}</summary>
                          <pre className="block">{d.context}</pre>
                        </details>
                      </td>
                      <td className="wrap">{d.alternative}</td>
                      <td>
                        <Judge id={d.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  )
}
