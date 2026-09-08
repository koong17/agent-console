import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { tracePlugin, traceRoutes } from './trace.js'
import { usageRoutes } from './usage.js'
import { sessionRoutes } from './sessions.js'
import { ingestScheduler } from './ingest/scheduler.js'

// 앱 조립과 listen을 분리한다. listen 없이 조립만 하면 OpenAPI 스펙을 파일로
// 뽑거나(openapi-emit.ts) 테스트에서 inject로 요청을 넣을 수 있다.
type BuildOptions = {
  // 스펙만 뽑을 때(openapi-emit)는 ingestion 타이머를 붙이지 않는다. 라우트는 항상 등록된다.
  ingest?: boolean
}

export async function buildApp({ ingest = true }: BuildOptions = {}) {
  // withTypeProvider: 라우트에 schema를 붙이면 req.query, reply 타입이 그 schema에서 나온다.
  // 한 번 적은 스키마가 (1) 요청 검증 (2) 응답 직렬화 (3) TS 타입 (4) OpenAPI 문서 넷을 만든다.
  const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>()

  await app.register(swagger, {
    openapi: {
      info: { title: 'agent-console', version: '0.1.0' },
      servers: [{ url: 'http://127.0.0.1:4000' }],
    },
  })

  tracePlugin(app)
  traceRoutes(app)
  usageRoutes(app)
  sessionRoutes(app)
  ingestScheduler(app, { schedule: ingest })

  // 스펙 자체도 엔드포인트로. 브라우저에서 바로 확인할 수 있다.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  // 관찰 대상 라우트 몇 개. /slow는 첫 차트에 볼 만한 게 있도록,
  // 눈에 띄는 지연 이상치를 하나 만들어 두는 용도다.
  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }))
  app.get('/slow', { schema: { hide: true } }, async () => {
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700))
    return { ok: true, note: 'deliberately slow' }
  })

  return app
}

export type App = Awaited<ReturnType<typeof buildApp>>
