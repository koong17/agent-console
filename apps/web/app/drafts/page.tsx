import { Nav } from '../nav'
import { api, unwrapAsync, type ApiData } from '../server'
import { fmtMinute } from '../format'
import { ErrorState } from '../error-state'
import { Decide } from './decide'

type Drafts = ApiData<'/evals/drafts'>

const CAUSE: Record<string, string> = { missing: '규칙 없음', ignored: '규칙 무시' }

// eval 케이스 초안 대기열. 교정 되짚기에서 나온 초안을 골라 suah-brain/evals/cases 에 파일로 남긴다.
export default async function DraftsPage() {
  let drafts: Drafts
  try {
    drafts = await unwrapAsync(api.GET('/evals/drafts'))
  } catch (err) {
    return <ErrorState title="drafts" error={err} />
  }

  const count = (s: string) => drafts.filter((d) => d.status === s).length

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
            <strong>{count('rejected')}</strong>
            <br />
            저장하면 suah-brain/evals/cases 에 <span className="mono">status: draft</span> 파일 하나를 만들어요. run-evals 는
            active 만 돌리니 평가에는 아직 안 들어가요. 커밋과 active 전환은 브레인 세션에서 해요. 같은 이름의 파일이 있으면
            덮지 않아요.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>time</th>
                  <th>cause</th>
                  <th>correction</th>
                  <th>draft</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.messageId} className={d.status === 'rejected' ? 'is-faint' : undefined}>
                    <td className="mono">{fmtMinute(String(d.ts))}</td>
                    <td>
                      {CAUSE[d.cause] ?? d.cause}
                      {d.rules.length > 0 && <span className="mono"> {d.rules.join(' ')}</span>}
                    </td>
                    <td className="wrap">{d.correction}</td>
                    <td className="wrap">
                      {/* 초안 전문은 길어서 접어 둔다. 제목만 보고 고르지 않게 펼쳐 볼 수 있어야 한다. */}
                      <details>
                        <summary>
                          {d.title} <span className="mono cell-zero">{d.caseId}</span>
                        </summary>
                        <pre className="block">{d.body}</pre>
                      </details>
                    </td>
                    <td>
                      {d.status === 'pending' ? (
                        <Decide messageId={d.messageId} />
                      ) : d.status === 'accepted' ? (
                        <>
                          저장함 <span className="mono">{d.path}</span>
                        </>
                      ) : (
                        '버림'
                      )}
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
