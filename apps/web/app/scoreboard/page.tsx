import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtMinute, fmtMinutes } from '../format'
import { ErrorState } from '../error-state'

type Minutes = ApiData<'/scoreboard/minutes'>
type Shadow = ApiData<'/scoreboard/shadow'>
type Interventions = ApiData<'/scoreboard/interventions'>
type Corrections = ApiData<'/scoreboard/corrections'>
type Evals = ApiData<'/scoreboard/evals'>
type Phases = ApiData<'/scoreboard/phases'>
type Drift = ApiData<'/scoreboard/drift'>
type Taste = ApiData<'/scoreboard/taste'>
const mark = (p: boolean | null) => (p === null ? '-' : p ? 'pass' : 'fail')
type Counts = Interventions['total']['counts']

const sum = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0)
// 활동 시간당 교정. 소수 둘째 자리 — 하루 몇 건 / 몇 시간이라 한 자리로는 날마다 차이가 안 보인다.
const perHour = (n: number, h: number) => (h ? (n / h).toFixed(2) : '-')

// 비율은 정수 퍼센트. 표본이 수십~백여 건이라 소수점은 가짜 정밀도다(DESIGN.md).
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-')

// 대체 로드맵의 점수판. 브레인이 수아를 얼마나 대신하는지를 숫자로 본다.
// 지금은 "수아 분" 하나. 블라인드 재예측과 보정 곡선이 같은 페이지에 붙는다.
export default async function ScoreboardPage() {
  let minutes: Minutes
  let shadow: Shadow
  let iv: Interventions
  let cr: Corrections
  let ev: Evals
  let ph: Phases
  let dr: Drift
  let ta: Taste
  try {
    ;[minutes, shadow, iv, cr, ev, ph, dr, ta] = await Promise.all([
      unwrapAsync(api.GET('/scoreboard/minutes')),
      unwrapAsync(api.GET('/scoreboard/shadow')),
      unwrapAsync(api.GET('/scoreboard/interventions')),
      unwrapAsync(api.GET('/scoreboard/corrections')),
      unwrapAsync(api.GET('/scoreboard/evals')),
      unwrapAsync(api.GET('/scoreboard/phases')),
      unwrapAsync(api.GET('/scoreboard/drift')),
      unwrapAsync(api.GET('/scoreboard/taste')),
    ])
  } catch (err) {
    return <ErrorState title="scoreboard" error={err} />
  }

  const { total, byDay, days } = minutes
  // 개입률 = (교정 + 방향 전환) / 메시지. 표본이 충분한 단계를 낮은 순으로 먼저, 나머지는 뒤에.
  const rate = (p: Phases['phases'][number]) => (p.correction + p.redirect) / p.messages
  const phases = [...ph.phases].sort((a, b) => {
    const ea = a.messages >= ph.minMessages
    const eb = b.messages >= ph.minMessages
    return ea !== eb ? (ea ? -1 : 1) : ea ? rate(a) - rate(b) : b.messages - a.messages
  })

  return (
    <main>
      <Nav />
      <h1>scoreboard</h1>
      <section>
        <h2>interventions</h2>
        {iv.classified === 0 ? (
          <p className="state">
            최근 {iv.days}일 메시지가 아직 분류되지 않았어요. <span className="mono">pnpm jobs message-intent</span> 를
            실행하세요.
          </p>
        ) : (
          <>
            <p className="summary">
              최근 {iv.days}일 교정 <strong>{iv.total.counts.correction}</strong>건 · 활동 시간당{' '}
              <strong>{perHour(iv.total.counts.correction, iv.total.activeHours)}</strong> · 분류된 메시지 100개당{' '}
              <strong>{sum(iv.total.counts) ? ((iv.total.counts.correction / sum(iv.total.counts)) * 100).toFixed(1) : '-'}</strong>
              {iv.classified < iv.typed && (
                <>
                  {' '}
                  · <span className="status-warning">분류 {iv.classified}/{iv.typed} — 아직 일부로 낸 값</span>
                </>
              )}
              <br />
              교정 = 에이전트가 틀려서 수아가 바로잡은 메시지. 브레인이 수아를 대신한다면 줄어야 하는 숫자예요. 활동
              시간은 메시지를 한 번이라도 친 시(hour)만 세요.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>day</th>
                    <th className="num">active h</th>
                    <th className="num">correction</th>
                    <th className="num">per h</th>
                    <th className="num">answer</th>
                    <th className="num">redirect</th>
                    <th className="num">approval</th>
                    <th className="num">new</th>
                    <th className="num">other</th>
                  </tr>
                </thead>
                <tbody>
                  {iv.byDay.map((d) => (
                    <tr key={d.day}>
                      <td className="mono">{d.day}</td>
                      <td className="num">{d.activeHours}</td>
                      <td className="num">{d.counts.correction}</td>
                      <td className="num">{perHour(d.counts.correction, d.activeHours)}</td>
                      <td className="num">{d.counts.answer}</td>
                      <td className="num">{d.counts.redirect}</td>
                      <td className="num">{d.counts.approval}</td>
                      <td className="num">{d.counts['new-request']}</td>
                      <td className="num">{d.counts.other}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {phases.length > 0 && (
        <section>
          <h2>by phase</h2>
          <p className="summary">
            단계 = 메시지 직전에 같은 세션에서 마지막으로 불린 스킬. 개입률(교정 + 방향 전환 / 메시지)이 낮은 단계가 먼저
            맡길 후보예요. 메시지 {ph.minMessages}개 미만은 흐리게 두고 뒤로 보냈어요. code-searching 같은 도구성 스킬도
            단계로 잡히는 게 이 기준의 한계예요.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>phase</th>
                  <th className="num">messages</th>
                  <th className="num">correction</th>
                  <th className="num">redirect</th>
                  <th className="num">intervention</th>
                </tr>
              </thead>
              <tbody>
                {phases.map((p) => (
                  <tr key={p.phase} className={p.messages < ph.minMessages ? 'is-faint' : undefined}>
                    <td>{p.phase}</td>
                    <td className="num">{p.messages}</td>
                    <td className="num">{p.correction}</td>
                    <td className="num">{p.redirect}</td>
                    <td className="num">{pct(p.correction + p.redirect, p.messages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2>correction replay</h2>
        {cr.replayed === 0 ? (
          <p className="state">
            아직 되짚은 교정이 없어요. <span className="mono">pnpm jobs correction-replay</span> 를 실행하세요.
          </p>
        ) : (
          <>
            <p className="summary">
              교정 <strong>{cr.total}</strong>건 중 <strong>{cr.replayed}</strong>건 되짚음 · 규칙 없음{' '}
              <strong>{cr.byCause.missing}</strong> · 규칙 무시 <strong>{cr.byCause.ignored}</strong> · 규칙이 틀림{' '}
              <strong>{cr.byCause.wrong}</strong> · 판단 문제 아님 <strong>{cr.byCause['not-judgment']}</strong>
              <br />
              그 시각의 sense.md 에 비춰 원인을 갈라요. 규칙 없음은 새 규칙을, 무시는 규칙이 읽히는 경로를, 틀림은 규칙
              자체를 고칠 곳이에요. inbox 초안은 자동으로 쓰지 않아요.
            </p>
            {cr.byRule.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>rule</th>
                      <th className="num">ignored</th>
                      <th className="num">wrong</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cr.byRule.map((r) => (
                      <tr key={r.rule}>
                        <td className="mono">{r.rule}</td>
                        <td className="num">{r.ignored}</td>
                        <td className="num">{r.wrong}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>time</th>
                    <th>cause</th>
                    <th>rule</th>
                    <th>correction</th>
                    <th>reason</th>
                    <th>inbox draft</th>
                  </tr>
                </thead>
                <tbody>
                  {cr.recent.map((c) => (
                    <tr key={c.messageId}>
                      <td className="mono">{fmtMinute(String(c.ts))}</td>
                      <td>{c.cause}</td>
                      <td className="mono">{c.rule ?? '-'}</td>
                      <td className="wrap">{c.text}</td>
                      <td className="wrap">{c.reason}</td>
                      <td className="wrap">{c.inboxDraft ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

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
                    {/* 선택지 라벨은 보통 짧지만 여기선 30자를 넘는 게 흔해서(측정: 최대 35자) nowrap 이면
                        두 열이 530px 를 먹고 표가 넘친다. 이 표에서만 줄바꿈을 허용한다. */}
                    <td className="wrap">{m.predicted}</td>
                    <td className="wrap">{m.chosen}</td>
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
        <h2>taste · kept lines</h2>
        {ta.commits.length > 0 && (
          <>
            <p className="summary">
              수아 님 명의로 Claude 와 함께 쓴 커밋(Co-Authored-By)이 더한 줄 가운데, 기준 브랜치의 그 파일에 아직 있는
              줄의 비율이에요. Bash 로 고친 것도 커밋에 들어가면 잡혀요. 줄 주인은 그 커밋들이 건드린 파일의 지금 줄을
              git blame 으로 나눈 거예요 — 되돌렸다가 다시 넣은(Reapply) 줄은 다시 넣은 사람 것으로 세져요.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>repo</th>
                    <th>base</th>
                    <th className="num">agent commits</th>
                    <th className="num">added lines</th>
                    <th className="num">kept %</th>
                    <th className="num">now: agent</th>
                    <th className="num">now: suah by hand</th>
                    <th className="num">now: others</th>
                  </tr>
                </thead>
                <tbody>
                  {ta.commits.map((c) => {
                    const total = c.agentLines + c.mineLines + c.otherLines
                    return (
                      <tr key={c.repo}>
                        <td>{c.repo}</td>
                        <td className="mono">{c.ref}</td>
                        <td className="num">{c.commits}</td>
                        <td className="num">{c.added.toLocaleString()}</td>
                        <td className="num">{pct(c.kept, c.added)}</td>
                        <td className="num">{pct(c.agentLines, total)}</td>
                        <td className="num">{pct(c.mineLines, total)}</td>
                        <td className="num">{pct(c.otherLines, total)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {ta.rewritten.length > 0 && (
              <>
                <p className="summary">
                  가장 많이 다시 쓰인 에이전트 커밋(더한 줄 20줄 이상). 무엇이 안 남았는지가 취향을 가리켜요. 파일을 옮긴 커밋은 그
                  파일이 나중에 또 옮겨지면 다시 쓰인 것처럼 보여요 — 같은 줄을 레포 전체에서 찾지는 않아요.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>repo</th>
                        <th>commit</th>
                        <th>subject</th>
                        <th className="num">added</th>
                        <th className="num">kept %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ta.rewritten.map((r) => (
                        <tr key={r.sha}>
                          <td>{r.repo}</td>
                          <td className="mono">
                            {r.sha.slice(0, 8)} <span className="cell-zero">{fmtMinute(String(r.committedAt)).slice(0, 10)}</span>
                          </td>
                          <td className="wrap">{r.subject}</td>
                          <td className="num">{r.added}</td>
                          <td className="num">{pct(r.kept, r.added)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
        {ta.byRepo.length === 0 ? (
          <p className="state">
            아직 재지 않았어요. <span className="mono">pnpm ingest</span> 다음에 <span className="mono">pnpm taste</span> 를
            실행하세요.
          </p>
        ) : (
          <>
            <p className="summary">
              도구 입력 기준(참고): 에이전트가 Edit/Write 로 더한 줄 가운데 기준 브랜치의 그 파일에 아직 있는 비율이에요.
              {ta.checkedAt && <> 잰 시각 {fmtMinute(String(ta.checkedAt))}.</>}
              <br />
              남았다 = 받아들여졌다지만, 사라졌다에는 수아 님이 고침·에이전트가 나중에 고침·옮겨감이 섞여 있어요. 기준
              브랜치에 파일이 없는 수정(머지 전일 수 있음)은 비율에서 빼고 따로 셌어요. Bash 로 고친 파일(python, sed)은 아직
              안 잡혀요.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>repo</th>
                    <th>base</th>
                    <th className="num">edits</th>
                    <th className="num">added lines</th>
                    <th className="num">kept</th>
                    <th className="num">kept %</th>
                    <th className="num">no file on base</th>
                  </tr>
                </thead>
                <tbody>
                  {ta.byRepo.map((r) => (
                    <tr key={r.repo}>
                      <td>{r.repo}</td>
                      <td className="mono">
                        {r.ref} <span className="cell-zero">{fmtMinute(String(r.refAt)).slice(0, 10)}</span>
                      </td>
                      <td className="num">{r.edits}</td>
                      <td className="num">{r.added.toLocaleString()}</td>
                      <td className="num">{r.kept.toLocaleString()}</td>
                      <td className="num">{pct(r.kept, r.added)}</td>
                      <td className="num">{r.noFile}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {dr.kinds.length > 0 && (
        <section>
          <h2>drift</h2>
          <p className="summary">
            답 정책이 바뀐 질문 종류 <strong>{dr.kinds.filter((k) => k.drifted).length}</strong>개 / 결정{' '}
            {dr.minDecisions}개 이상인 종류 {dr.kinds.length}개. 결정을 시간순으로 반씩 나눠 앞뒤에서 가장 많이 나온 정책을
            비교해요. 결정이 적은 종류는 한 번 다르게 답한 것도 바뀐 걸로 보여요 — 개수를 같이 보세요.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>kind</th>
                  <th className="num">n</th>
                  <th>earlier</th>
                  <th>later</th>
                  <th>first</th>
                  <th>last</th>
                </tr>
              </thead>
              <tbody>
                {dr.kinds.map((k) => (
                  <tr key={k.kind}>
                    <td>{k.kind}</td>
                    <td className="num">{k.n}</td>
                    <td className="wrap">
                      {k.early} <span className="cell-zero">×{k.earlyCount}</span>
                    </td>
                    <td className={k.drifted ? 'wrap status-warning' : 'wrap'}>
                      {k.late} <span className="cell-zero">×{k.lateCount}</span>
                    </td>
                    <td className="mono">{fmtMinute(String(k.firstAt)).slice(0, 10)}</td>
                    <td className="mono">{fmtMinute(String(k.lastAt)).slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2>evals</h2>
        {ev.models.length === 0 ? (
          <p className="state">
            아직 평가 결과가 없어요. suah-brain 에서 <span className="mono">node scripts/run-evals.mjs</span> 를 돌린 뒤{' '}
            <span className="mono">pnpm ingest</span> 를 실행하세요.
          </p>
        ) : (
          <>
            {ev.models.map((m) => (
              <p className="summary" key={m.model}>
                <span className="mono">{m.model}</span> · 케이스 <strong>{m.cases}</strong>개 중 full 통과{' '}
                <strong>{m.fullPass}</strong> · baseline 과 짝지은 {m.paired}개 중 브레인이 만든 차이{' '}
                <strong>{m.brainEffect}</strong>, 브레인 없이도 통과 <strong className="status-warning">{m.notTesting}</strong> ·
                holdout 과 짝지은 {m.heldOut}개 중 그 규칙 줄에만 적힌 판례 <strong>{m.isolated}</strong>
              </p>
            ))}
            <p className="summary">
              케이스마다 모드별 최신 결과로 판정해요. baseline 통과 케이스는 브레인을 시험하지 않으므로 조이거나 빼야
              해요(run-evals.mjs). 단, 최신 baseline 이 케이스를 고치기 전에 돈 것일 수 있어요 — 고친 케이스는 baseline 을
              다시 돌려야 정확해요.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>case</th>
                    <th>rules</th>
                    <th>full</th>
                    <th>baseline</th>
                    <th>holdout</th>
                    <th>last run</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.cases.map((c) => (
                    <tr key={`${c.model}-${c.caseId}`}>
                      <td>{c.caseId}</td>
                      <td className="mono">{c.rules.join(' ')}</td>
                      <td className={c.full === false ? 'status-warning' : undefined}>{mark(c.full)}</td>
                      {/* baseline 통과가 경고다 — 브레인 없이도 맞혔다는 뜻 */}
                      <td className={c.baseline === true ? 'status-warning' : undefined}>{mark(c.baseline)}</td>
                      <td>{mark(c.holdout)}</td>
                      <td className="mono">{fmtMinute(String(c.lastRunAt))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

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
