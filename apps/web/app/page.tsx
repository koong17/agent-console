import { AutoRefresh } from './auto-refresh'
import { Nav } from './nav'
import { fetchJson } from './server'
import { fmtTime } from './format'

// 서버 쪽 Trace 타입의 JSON 직렬화 형태. Date는 전송 중 문자열이 된다.
// packages/contract가 생기면 그쪽 생성물로 대체한다.
type Trace = {
  id: number
  requestId: string
  method: string
  url: string
  statusCode: number
  durationMs: number
  startedAt: string
}

// 느린 요청 기준. 이 이상이면 행을 에러 색으로 표시한다.
const SLOW_MS = 200

// 서버 컴포넌트. 이 fetch는 브라우저가 아니라 Next 서버 프로세스에서 실행된다.
// 그래서 Fastify에 CORS 설정 없이도 4000 포트를 바로 부를 수 있다.
export default async function Page() {
  const traces = await fetchJson<Trace[]>('/traces?limit=50')

  return (
    <main>
      <Nav />
      <h1>traces</h1>
      <p className="summary">
        최근 <strong>{traces.length}</strong>건 · 2초마다 갱신 · <strong>{SLOW_MS}ms</strong> 넘으면 빨강
      </p>
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
