import Link from 'next/link'
import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtMinute } from '../format'
import { ErrorState } from '../error-state'

type Report = ApiData<'/decisions'>

// 추천 라벨의 "(Recommended)" / "(추천)" / "(권장)" 꼬리는 훅이 추천을 알아내는 표식이지 내용이 아니다.
// 표에서는 떼고 보여준다. 어느 쪽이 추천이었는지는 별도 열이 말한다.
// 패턴은 훅(scripts/hooks/log-decision.sh), 서버(jobs/shadow-predict.ts)와 같아야 한다. 예전엔 권장이 빠져 있었다.
const stripMarker = (label: string | null) =>
  label === null ? '-' : label.replace(/\s*\((Recommended|추천|권장)\)\s*$/, '')

export default async function DecisionsPage() {
  let report: Report
  try {
    report = await unwrapAsync(api.GET('/decisions'))
  } catch (err) {
    return <ErrorState title="decisions" error={err} />
  }

  const { total, judged, agreed, rate, missingRecommended: miss, items } = report

  return (
    <main>
      <Nav />
      <h1>decisions</h1>
      {total === 0 ? (
        <p className="state">
          아직 결정 기록이 없어요. 에이전트가 선택지를 물으면(AskUserQuestion) 훅이 남기고 ingestion이
          가져와요.
        </p>
      ) : (
        <>
          <p className="summary">
            추천 동의율 <strong>{rate === null ? '-' : `${Math.round(rate * 100)}%`}</strong> · 판정 가능{' '}
            <strong>{judged}</strong>건 중 <strong>{agreed}</strong>건 추천대로 · 전체 <strong>{total}</strong>건
            <br />
            추천이 없거나 답을 읽지 못한 결정은 분모에서 빼요. 이 숫자는 추천을 따른 빈도만 말하고, 추천이
            옳았는지는 말하지 않아요.
          </p>
          {/* 추천 없는 질문은 채점할 수 없다. 점수의 분모에서 조용히 빠지므로 여기서 따로 드러낸다. */}
          {miss.alarm && (
            <p className="summary">
              <span className="status-warning">
                최근 {miss.windowDays}일 질문 <strong>{miss.total}</strong>건 중 <strong>{miss.missing}</strong>건에
                추천이 없어요{miss.multiSelect > 0 && <> (그중 복수 선택 {miss.multiSelect}건은 경보에서 뺐어요)</>}.
                추천 없는 질문은 예측 점수에 못 들어가요. 표의 recommended 가 - 인 행이에요.
              </span>
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>time</th>
                  <th>repo</th>
                  <th>question</th>
                  <th>chosen</th>
                  <th>recommended</th>
                  <th>agreed</th>
                  <th>session</th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{fmtMinute(String(d.ts))}</td>
                    <td>{d.repo ?? '-'}</td>
                    {/* 질문은 문장이라 줄바꿈을 허용한다. 선택지 라벨은 짧아(1~5단어) nowrap으로 두어
                        질문 열이 남는 폭을 가져가게 한다. 선택지 전체는 툴팁으로. */}
                    <td className="wrap" title={d.options.join(' | ')}>
                      {d.header && <span className="cell-zero">{d.header} · </span>}
                      {d.question}
                    </td>
                    <td>{stripMarker(d.chosen)}</td>
                    <td>{stripMarker(d.recommended)}</td>
                    <td className={d.agreed === null ? 'cell-zero' : undefined}>
                      {d.agreed === null ? '-' : d.agreed ? 'yes' : 'no'}
                    </td>
                    <td className="mono">
                      <Link href={`/sessions/${d.sessionId}`}>{d.sessionId.slice(0, 8)}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  )
}
