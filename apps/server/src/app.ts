import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { tracePlugin, traceRoutes } from './trace.js'
import { usageRoutes } from './usage.js'
import { sessionRoutes } from './sessions.js'
import { harnessRoutes } from './harness.js'
import { brainRoutes } from './brain.js'
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
  harnessRoutes(app)
  brainRoutes(app)
  ingestScheduler(app, { schedule: ingest })

  // 스펙 자체도 엔드포인트로. 브라우저에서 바로 확인할 수 있다.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  // 관찰 대상 라우트 몇 개. /slow는 첫 차트에 볼 만한 게 있도록,
  // 눈에 띄는 지연 이상치를 하나 만들어 두는 용도다.
  // health는 "프로세스가 떠 있다"가 아니라 "일할 수 있다"를 답해야 한다. 2026-09-08 아침 Postgres가
  // 죽었는데 이 라우트는 ok:true 를 돌려줬고, 트레이스와 ingestion은 조용히 실패하고 있었다.
  // select 1 은 연결 확인용 가장 가벼운 쿼리다. 실패하면 503(Service Unavailable).
  // 1초 넘게 걸려도 실패로 친다. 응답 없는 DB에 health 요청이 매달려 있으면 안 된다.
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: Type.Object({ ok: Type.Literal(true), db: Type.Literal('up') }),
          503: Type.Object({ ok: Type.Literal(false), db: Type.Literal('down'), error: Type.String() }),
        },
      },
    },
    async (_req, reply) => {
      try {
        await Promise.race([
          db.execute(sql`select 1`),
          new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout 1000ms')), 1000).unref()),
        ])
        return { ok: true as const, db: 'up' as const }
      } catch (err) {
        return reply.code(503).send({
          ok: false as const,
          db: 'down' as const,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )
  app.get('/slow', { schema: { hide: true } }, async () => {
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700))
    return { ok: true, note: 'deliberately slow' }
  })

  return app
}

export type App = Awaited<ReturnType<typeof buildApp>>
