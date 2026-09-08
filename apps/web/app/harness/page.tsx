import { Nav } from '../nav'
import { api, unwrap, type ApiData } from '../server'
import { fmtDay } from '../format'
import { ErrorState } from '../error-state'

type Report = ApiData<'/harness/rules'>
type Rule = Report['rules'][number]

// 상태별 표시. 텍스트 색만 바꾼다(DESIGN.md: 배경으로 행 강조하지 않는다).
const STATUS_LABEL: Record<Rule['status'], string> = {
  dead: 'dead',
  quiet: 'quiet',
  ok: 'ok',
  insufficient: '-',
}

const fmtDays = (d: number | null) =>
  d === null ? '-' : d < 1 ? `${Math.round(d * 24)}h` : `${d.toFixed(1)}d`

export default async function HarnessPage() {
  let report: Report
  try {
    report = unwrap(await api.GET('/harness/rules'))
  } catch (err) {
    return <ErrorState title="harness" error={err} />
  }

  const { thresholds: t, rules } = report
  const dead = rules.filter((r) => r.status === 'dead').length
  const quiet = rules.filter((r) => r.status === 'quiet').length

  return (
    <main>
      <Nav />
      <h1>harness</h1>
      <p className="summary">
        규칙 <strong>{rules.length}</strong>개 · dead <strong>{dead}</strong> · quiet <strong>{quiet}</strong>
        <br />
        dead = 침묵이 평소 간격의 {t.deadMultiplier}배(최소 {t.deadFloorDays}일)를 넘김 · quiet ={' '}
        {t.quietMultiplier}배 · 호출 {t.minEvents}회 미만은 판정 안 함
      </p>
      <section>
        <h2>rules</h2>
        {rules.length === 0 ? (
          <p className="state">아직 규칙 호출 기록이 없어요. ingestion이 돌면 채워져요.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>rule</th>
                  <th>kind</th>
                  <th>status</th>
                  <th className="num">silence</th>
                  <th className="num">usual gap</th>
                  <th className="num">total</th>
                  <th>first</th>
                  <th>last</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.name} className={r.status === 'dead' ? 'is-error' : undefined}>
                    <td>{r.name}</td>
                    <td className="mono">{r.kind}</td>
                    <td
                      className={
                        r.status === 'quiet'
                          ? 'status-warning'
                          : r.status === 'insufficient'
                            ? 'cell-zero'
                            : undefined
                      }
                    >
                      {STATUS_LABEL[r.status]}
                    </td>
                    <td className="num">{fmtDays(r.silenceDays)}</td>
                    <td className="num">{fmtDays(r.medianGapDays)}</td>
                    <td className="num">{r.total}</td>
                    <td className="mono">{fmtDay(String(r.firstAt))}</td>
                    <td className="mono">{fmtDay(String(r.lastAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}
