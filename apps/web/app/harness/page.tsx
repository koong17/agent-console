import { Nav } from '../nav'
import { api, unwrap, type ApiData } from '../server'
import Link from 'next/link'
import { fmtDay, fmtMinute } from '../format'
import { ErrorState } from '../error-state'

type Report = ApiData<'/harness/rules'>
type Rule = Report['rules'][number]
type Zombies = ApiData<'/harness/zombies'>

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
  let zombies: Zombies
  try {
    const [r, z] = await Promise.all([api.GET('/harness/rules'), api.GET('/harness/zombies')])
    report = unwrap(r)
    zombies = unwrap(z)
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
        <h2>zombie sessions</h2>
        <p className="summary">
          하네스 마지막 변경 <strong>{fmtMinute(String(zombies.harnessChangedAt))}</strong>{' '}
          <span className="mono">{zombies.changedFile}</span> · 그 전에 시작했고 최근{' '}
          {zombies.activeWindowHours}시간 안에 활동한 세션{' '}
          <strong className={zombies.sessions.length > 0 ? 'status-warning' : undefined}>
            {zombies.sessions.length}
          </strong>
          개 · 재시작해야 새 훅 설정을 받아요
        </p>
        {zombies.sessions.length === 0 ? (
          <p className="state">좀비 세션 없음. 살아 있는 세션은 전부 최신 설정이에요.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>session</th>
                  <th>repo</th>
                  <th>started</th>
                  <th>last seen</th>
                  <th className="num">age</th>
                  <th className="num">behind</th>
                  <th className="num">turns</th>
                </tr>
              </thead>
              <tbody>
                {zombies.sessions.map((z) => (
                  <tr key={z.id}>
                    <td className="mono">
                      <Link href={`/sessions/${z.id}`}>{z.id.slice(0, 8)}</Link>
                    </td>
                    <td>{z.repo}</td>
                    <td className="mono">{fmtMinute(String(z.startedAt))}</td>
                    <td className="mono">{fmtMinute(String(z.lastSeenAt))}</td>
                    <td className="num">{z.ageDays.toFixed(1)}d</td>
                    <td className="num">{z.behindDays.toFixed(1)}d</td>
                    <td className="num">{z.turns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
