import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtMinute, fmtMinutes } from '../format'
import { ErrorState } from '../error-state'

type Minutes = ApiData<'/scoreboard/minutes'>
type Shadow = ApiData<'/scoreboard/shadow'>

// 비율은 정수 퍼센트. 표본이 수십~백여 건이라 소수점은 가짜 정밀도다(DESIGN.md).
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-')

// 대체 로드맵의 점수판. 브레인이 수아를 얼마나 대신하는지를 숫자로 본다.
// 지금은 "수아 분" 하나. 블라인드 재예측과 보정 곡선이 같은 페이지에 붙는다.
export default async function ScoreboardPage() {
  let minutes: Minutes
  let shadow: Shadow
  try {
    ;[minutes, shadow] = await Promise.all([
      unwrapAsync(api.GET('/scoreboard/minutes')),
      unwrapAsync(api.GET('/scoreboard/shadow')),
    ])
  } catch (err) {
    return <ErrorState title="scoreboard" error={err} />
  }

  const { total, byDay, days } = minutes

  return (
    <main>
      <Nav />
      <h1>scoreboard</h1>
      <section>
        <h2>blind prediction</h2>
        {shadow.n === 0 ? (
          <p className="state">
            아직 재예측이 없어요. <span className="mono">pnpm jobs shadow-predict</span> 를 실행하세요.
          </p>
        ) : (
          <>
            <p className="summary">
              브레인이 추천 없이 맞힌 비율 <strong>{pct(shadow.correct, shadow.n)}</strong> ({shadow.correct}/
              {shadow.n}) · 같은 결정 중 추천이 있던 {shadow.anchored.n}건에서 수아가 추천을 고른 비율{' '}
              <strong>{pct(shadow.anchored.suahChoseRecommended, shadow.anchored.n)}</strong> · 브레인 답이 그때
              추천과 같은 비율 <strong>{pct(shadow.anchored.brainPickedRecommended, shadow.anchored.n)}</strong>
              <br />
              결정마다 그 시각 직전 커밋의 sense.md 로, 질문과 선택지만 보여주고 다시 고르게 했어요. 수아는 추천을 보고
              골랐으니 가운데 숫자는 닻이 내린 점수고, 첫 숫자가 닻 없는 점수예요. 앞 대화를 안 보여주므로 "위 답
              반영 후" 같은 질문은 맞히기 어려워요.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>confidence</th>
                    <th className="num">n</th>
                    <th className="num">mean confidence</th>
                    <th className="num">accuracy</th>
                  </tr>
                </thead>
                <tbody>
                  {/* 보정: 잘 보정된 브레인이면 확신 칸의 평균과 정답률이 비슷하다.
                      정답률이 확신보다 낮으면 자신만만하게 틀리는 쪽이다. */}
                  {shadow.calibration.map((b) => (
                    <tr key={b.from}>
                      <td className="mono">
                        {b.from.toFixed(1)}–{b.to.toFixed(1)}
                      </td>
                      <td className="num">{b.n}</td>
                      <td className="num">{b.n ? `${Math.round(b.meanConfidence * 100)}%` : '-'}</td>
                      <td className="num">{pct(b.correct, b.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {shadow.n > 0 && (
        <section>
          <h2>by question kind</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>kind</th>
                  <th className="num">n</th>
                  <th className="num">correct</th>
                  <th className="num">accuracy</th>
                </tr>
              </thead>
              <tbody>
                {shadow.byKind.map((k) => (
                  <tr key={k.kind}>
                    <td>{k.kind}</td>
                    <td className="num">{k.n}</td>
                    <td className="num">{k.correct}</td>
                    <td className="num">{pct(k.correct, k.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {shadow.misses.length > 0 && (
        <section>
          <h2>misses</h2>
          <p className="summary">브레인이 틀린 결정, 최근 것부터. 이유는 브레인이 댄 근거예요 — 어느 규칙이 잘못 읽혔는지 보여줘요.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>time</th>
                  <th>kind</th>
                  <th>question</th>
                  <th>brain</th>
                  <th>suah</th>
                  <th className="num">conf</th>
                  <th>reason</th>
                </tr>
              </thead>
              <tbody>
                {shadow.misses.map((m) => (
                  <tr key={m.decisionId}>
                    <td className="mono">{fmtMinute(String(m.ts))}</td>
                    <td>{m.kind ?? '-'}</td>
                    <td className="wrap">{m.question}</td>
                    <td>{m.predicted}</td>
                    <td>{m.chosen}</td>
                    <td className="num">{Math.round(m.confidence * 100)}%</td>
                    <td className="wrap">{m.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section>
        <h2>suah minutes</h2>
        {byDay.length === 0 ? (
          <p className="state">
            아직 데이터가 없어요. <span className="mono">pnpm ingest</span> 를 실행하세요.
          </p>
        ) : (
          <>
            <p className="summary">
              최근 {days}일 · 에이전트가 말을 멈춘 뒤 다음 메시지까지 중앙값{' '}
              <strong>{fmtMinutes(total.reply.p50)}</strong>분 (p90 {fmtMinutes(total.reply.p90)}분,{' '}
              {total.reply.n}건) · 질문이 뜬 뒤 답까지 중앙값 <strong>{fmtMinutes(total.question.p50)}</strong>분 (p90{' '}
              {fmtMinutes(total.question.p90)}분, {total.question.n}건)
              <br />
              합계가 아니라 중앙값을 봐요. 자리를 비운 몇 시간짜리 간격이 합계를 다 차지하기 때문이에요. 꼬리는 p90
              이 보여줘요.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>day</th>
                    <th className="num">reply n</th>
                    <th className="num">reply p50 (분)</th>
                    <th className="num">reply p90 (분)</th>
                    <th className="num">question n</th>
                    <th className="num">question p50 (분)</th>
                    <th className="num">question p90 (분)</th>
                  </tr>
                </thead>
                <tbody>
                  {byDay.map((d) => (
                    <tr key={d.day}>
                      <td className="mono">{d.day}</td>
                      <td className="num">{d.reply.n}</td>
                      <td className="num">{fmtMinutes(d.reply.p50)}</td>
                      <td className="num">{fmtMinutes(d.reply.p90)}</td>
                      <td className="num">{d.question.n}</td>
                      <td className="num">{fmtMinutes(d.question.p50)}</td>
                      <td className="num">{fmtMinutes(d.question.p90)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  )
}
