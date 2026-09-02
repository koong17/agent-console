import { AutoRefresh } from './auto-refresh'
import { Nav } from './nav'
import { fetchJson } from './server'

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

// 서버 컴포넌트. 이 fetch는 브라우저가 아니라 Next 서버 프로세스에서 실행된다.
// 그래서 Fastify에 CORS 설정 없이도 4000 포트를 바로 부를 수 있다.
export default async function Page() {
  const traces = await fetchJson<Trace[]>('/traces?limit=50')

  return (
    <main>
      <Nav />
      <h1>traces</h1>
      <p>최근 {traces.length}건 · 2초마다 갱신</p>
      <AutoRefresh intervalMs={2000} />
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #999' }}>
            <th>시각</th>
            <th>method</th>
            <th>url</th>
            <th>status</th>
            <th>ms</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.id} style={{ color: t.durationMs > 200 ? 'crimson' : 'inherit' }}>
              <td>{t.startedAt.slice(11, 23)}</td>
              <td>{t.method}</td>
              <td>{t.url}</td>
              <td>{t.statusCode}</td>
              <td style={{ textAlign: 'right' }}>{t.durationMs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
