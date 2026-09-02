import type { FastifyInstance } from 'fastify'

// 완료된 HTTP 요청 하나당 한 줄. 자기 관찰의 최소 단위이며
// 대시보드가 그릴 모든 차트는 이 형태에서 파생된다.
export type Trace = {
  id: string
  method: string
  url: string
  statusCode: number
  durationMs: number
  startedAt: string
}

// 메모리 링 버퍼, 최신순. 오래 켜둔 dev 서버가 무한히 커지지 않도록 상한을 둔다.
// milestone 2에서 Postgres로 교체 예정 — 그때 살아남는 건 플러그인의 표면(기록/조회)이다.
const MAX_TRACES = 1000
const traces: Trace[] = []

export function listTraces(limit = 100): Trace[] {
  return traces.slice(0, limit)
}

export function tracePlugin(app: FastifyInstance) {
  // Fastify에는 Express식 미들웨어 체인이 없고 이름 붙은 라이프사이클 훅이 있다.
  // onRequest(가장 이른 지점)에서 시각을 찍고, onResponse(응답 전송 후)에서
  // 소요 시간을 계산한다. 응답 뒤에 측정하므로 측정 자체가 응답 지연을 만들지 않는다.
  app.addHook('onRequest', async (req) => {
    req.startTime = process.hrtime.bigint()
  })

  app.addHook('onResponse', async (req, reply) => {
    // 트레이스 목록 엔드포인트 자신은 제외한다. 안 그러면 대시보드 폴링이
    // 자기가 보여주는 데이터를 스스로 채워버린다.
    if (req.routeOptions.url === '/traces') return

    const durationNs = process.hrtime.bigint() - req.startTime
    traces.unshift({
      id: req.id,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      durationMs: Number(durationNs / 1_000_000n),
      startedAt: new Date().toISOString(),
    })
    if (traces.length > MAX_TRACES) traces.pop()
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    startTime: bigint
  }
}
