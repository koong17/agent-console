import { AutoRefresh } from './auto-refresh'
import { Nav } from './nav'
import { api, unwrapAsync, type ApiData } from './server'
import { fmtTime } from './format'
import { IngestStatus } from './ingest-status'
import { ErrorState } from './error-state'

// 느린 요청 기준. 이 이상이면 행을 에러 색으로 표시한다.
const SLOW_MS = 200

// 서버 컴포넌트. 이 fetch는 브라우저가 아니라 Next 서버 프로세스에서 실행된다.
// 그래서 Fastify에 CORS 설정 없이도 4000 포트를 바로 부를 수 있다.
export default async function Page() {
  // 경로와 쿼리가 계약으로 검사된다. '/trace' 오타, limit: '50' 문자열 모두 컴파일 에러.
  let traces: ApiData<'/traces'>
  let ingest: ApiData<'/ingest/status'>
  try {
    ;[traces, ingest] = await Promise.all([
      unwrapAsync(api.GET('/traces', { params: { query: { limit: 50 } } })),
      unwrapAsync(api.GET('/ingest/status')),
    ])
  } catch (err) {
    // 서버나 DB가 죽어 있으면 여기로 온다. fetch 자체가 실패(ECONNREFUSED)해도 잡힌다.
    return <ErrorState title="traces" error={err} />
  }

  return (
    <main>
      <Nav />
      <h1>traces</h1>
      <p className="summary">
        최근 <strong>{traces.length}</strong>건 · 2초마다 갱신 · <strong>{SLOW_MS}ms</strong> 넘으면 빨강
      </p>
      <IngestStatus status={ingest} />
      <AutoRefresh intervalMs={2000} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">time</th>
              <th>method</th>
              <th>url</th>
              <th className="num">status</th>
              <th className="num">ms</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.id} className={t.durationMs > SLOW_MS ? 'is-error' : undefined}>
                <td className="num">{fmtTime(t.startedAt)}</td>
                <td>{t.method}</td>
                <td className="mono">{t.url}</td>
                <td className="num">{t.statusCode}</td>
                <td className="num">{t.durationMs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}
