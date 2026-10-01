import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtMinute } from '../format'
import { ErrorState } from '../error-state'
import { Decide, DecideTheme } from './decide'

type Drafts = ApiData<'/evals/drafts'>
type Draft = Drafts[number]
type Themes = ApiData<'/evals/themes'>
type TasteThemes = ApiData<'/taste/themes'>
const COVERED: Record<string, string> = { none: '새 규칙', partial: '일부 있음', full: '이미 있음(무시됨)' }

// eval 케이스 초안 대기열. 교정 되짚기에서 나온 초안을 골라 suah-brain/evals/cases 에 파일로 남긴다.
//
// 두 덩어리로 나눈다(2026-09-30 수아가 "규칙 없음을 주제로 묶기"를 골랐다).
//   규칙 없음 — 주제별. 주제 하나가 새 규칙 후보 하나다. 대표 초안 하나만 펼쳐 두고 나머지는 접는다.
//   규칙 무시 — 규칙 id 가 이미 묶음이라 그대로 나열한다.
export default async function DraftsPage() {
  let drafts: Drafts
  let themes: Themes
  let taste: TasteThemes
  try {
    ;[drafts, themes, taste] = await Promise.all([
      unwrapAsync(api.GET('/evals/drafts')),
      unwrapAsync(api.GET('/evals/themes')),
      unwrapAsync(api.GET('/taste/themes')),
    ])
  } catch (err) {
    return <ErrorState title="drafts" error={err} />
  }

  const count = (s: string) => drafts.filter((d) => d.status === s).length
  const byTheme = new Map<string, Draft[]>()
  for (const d of drafts) if (d.theme) byTheme.set(d.theme, [...(byTheme.get(d.theme) ?? []), d])
  const byCase = new Map(drafts.map((d) => [d.caseId, d]))
  const ignored = drafts.filter((d) => d.cause === 'ignored')
  // 주제가 아직 없는 규칙 없음 초안(주제 묶기 뒤에 새로 생긴 것). 숨기지 않고 따로 보여준다.
  const unthemed = drafts.filter((d) => d.cause === 'missing' && !d.theme)

  return (
    <main>
      <Nav />
      <h1>drafts</h1>
      {drafts.length === 0 ? (
        <p className="state">
          아직 초안이 없어요. <span className="mono">pnpm jobs correction-replay</span> 다음에{' '}
          <span className="mono">pnpm jobs eval-draft</span> 를 실행하세요.
        </p>
      ) : (
        <>
          <p className="summary">
            결정할 초안 <strong>{count('pending')}</strong> · 저장 <strong>{count('accepted')}</strong> · 버림{' '}
            <strong>{count('rejected')}</strong> · 규칙 없음 주제 <strong>{themes.length}</strong>개
            <br />
            저장하면 suah-brain/evals/cases 에 <span className="mono">status: draft</span> 파일 하나를 만들어요. run-evals 는
            active 만 돌리니 평가에는 아직 안 들어가요. 커밋과 active 전환은 브레인 세션에서 해요. 같은 이름의 파일이 있으면
            덮지 않아요.
          </p>

          {taste.length > 0 && (
            <section>
              <h2>taste rules · to inbox</h2>
              <p className="summary">
                다시 쓰인 에이전트 커밋에서 뽑은 취향을 주제로 묶고, 지금 sense.md·principles.md 에 이미 있는지 맞대 봤어요.
                "inbox 에 추가"를 누르면 suah-brain/inbox.md 끝에 영어 한 줄이 붙어요(커밋은 안 해요). "이미 있음"은 규칙이
                있는데 무시된 경우라 새 규칙보다 읽히는 경로를 고칠 일이에요.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>rule</th>
                      <th className="num">seen</th>
                      <th>in brain</th>
                      <th>status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taste.map((t) => (
                      <tr key={t.id} className={t.status === 'rejected' ? 'is-faint' : undefined}>
                        <td className="wrap">
                          {t.summaryKo}
                          <div className="cell-zero">{t.lesson}</div>
                        </td>
                        <td className="num">{t.count}</td>
                        <td className="wrap">
                          {COVERED[t.covered] ?? t.covered}
                          {t.coveredBy && <div className="cell-zero">{t.coveredBy}</div>}
                        </td>
                        <td>
                          {t.status === 'pending' ? <DecideTheme id={t.id} /> : t.status === 'accepted' ? '추가함' : '버림'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h2>no rule · by theme</h2>
            <p className="summary">
              주제 하나 = 새 규칙 후보 하나. 초안 수가 크면 그 규칙이 여러 번 필요했다는 뜻이에요. 대표 초안 하나를
              저장하면 그 주제를 지키는 케이스가 생겨요.
            </p>
            {themes.length === 0 ? (
              <p className="state">
                아직 주제로 묶지 않았어요. <span className="mono">pnpm jobs draft-theme</span> 을 실행하세요.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>theme</th>
                      <th className="num">drafts</th>
                      <th className="num">pending</th>
                      <th>representative</th>
                      <th>status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {themes.map((t) => {
                      const rep = byCase.get(t.representative)
                      const others = (byTheme.get(t.name) ?? []).filter((d) => d.caseId !== t.representative)
                      return (
                        <tr key={t.name} className={t.pending === 0 ? 'is-faint' : undefined}>
                          <td className="wrap">
                            {t.name}
                            <div className="cell-zero">{t.description}</div>
                          </td>
                          <td className="num">{t.count}</td>
                          <td className="num">{t.pending}</td>
                          <td className="wrap">
                            {rep && <DraftBody d={rep} />}
                            {others.length > 0 && (
                              <details>
                                <summary className="cell-zero">같은 주제 초안 {others.length}개</summary>
                                {others.map((d) => (
                                  <div key={d.messageId}>
                                    <DraftBody d={d} />
                                    <Status d={d} />
                                  </div>
                                ))}
                              </details>
                            )}
                          </td>
                          <td>{rep && <Status d={rep} />}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {unthemed.length > 0 && (
              <p className="summary">
                <span className="status-warning">주제가 없는 규칙 없음 초안 {unthemed.length}개</span> — 주제를 묶은 뒤에 생겼어요.{' '}
                <span className="mono">pnpm jobs draft-theme</span> 으로 다시 묶으세요.
              </p>
            )}
          </section>

          <section>
            <h2>rule ignored</h2>
            <p className="summary">규칙은 있었는데 에이전트가 안 따른 교정. 저장하면 그 규칙이 실제로 읽히는지 지키는 케이스가 돼요.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>time</th>
                    <th>rule</th>
                    <th>correction → draft</th>
                    <th>status</th>
                  </tr>
                </thead>
                <tbody>
                  {ignored.map((d) => (
                    <tr key={d.messageId} className={d.status === 'rejected' ? 'is-faint' : undefined}>
                      <td className="mono">{fmtMinute(String(d.ts))}</td>
                      <td className="mono">{d.rules.join(' ') || '-'}</td>
                      {/* 교정과 초안을 한 칸에 둔다. 따로 두면 문장 열 두 개(최대 480씩)와 버튼 열이 1152 를 넘는다(측정: 113px). */}
                      <td className="wrap">
                        <div className="cell-zero">{d.correction}</div>
                        <DraftBody d={d} />
                      </td>
                      <td>
                        <Status d={d} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  )
}

// 초안 전문은 길어서 접어 둔다. 제목만 보고 고르지 않게 펼쳐 볼 수 있어야 한다.
function DraftBody({ d }: { d: Draft }) {
  return (
    <details>
      <summary>
        {d.title} <span className="mono cell-zero">{d.caseId}</span>
      </summary>
      <pre className="block">{d.body}</pre>
    </details>
  )
}

function Status({ d }: { d: Draft }) {
  if (d.status === 'pending') return <Decide messageId={d.messageId} />
  // 경로를 그대로 쓰면 긴 파일 이름이 버튼 자리를 넓혀 표가 흐트러진다. 상태만 보이고 경로는 마우스를 올리면 뜬다.
  if (d.status === 'accepted') return <span title={d.path ?? undefined}>저장함</span>
  return <>버림</>
}
