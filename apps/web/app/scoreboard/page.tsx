import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtMinutes } from '../format'
import { ErrorState } from '../error-state'

type Minutes = ApiData<'/scoreboard/minutes'>

// 대체 로드맵의 점수판. 브레인이 수아를 얼마나 대신하는지를 숫자로 본다.
// 지금은 "수아 분" 하나. 블라인드 재예측과 보정 곡선이 같은 페이지에 붙는다.
export default async function ScoreboardPage() {
  let minutes: Minutes
  try {
    minutes = await unwrapAsync(api.GET('/scoreboard/minutes'))
  } catch (err) {
    return <ErrorState title="scoreboard" error={err} />
  }

  const { total, byDay, days } = minutes

  return (
    <main>
      <Nav />
      <h1>scoreboard</h1>
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
