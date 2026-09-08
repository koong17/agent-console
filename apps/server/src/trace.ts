import type { FastifyInstance } from 'fastify'
import { Type } from 'typebox'
import { desc } from 'drizzle-orm'
import type { App } from './app.js'
import { db } from './db/index.js'
import { traces, type Trace } from './db/schema.js'

export type { Trace }

// 응답 스키마. DB의 Trace와 같은 모양이지만 startedAt이 Date가 아니라 문자열이다.
// 이 경계(DB 타입 → 전송 타입)를 스키마가 명시한다. 여기 없는 필드는 응답에서 잘린다.
export const TraceSchema = Type.Object(
  {
    id: Type.Integer(),
    requestId: Type.String(),
    method: Type.String(),
    url: Type.String(),
    statusCode: Type.Integer(),
    durationMs: Type.Integer(),
    startedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Trace' },
)

export function traceRoutes(app: App) {
  app.get(
    '/traces',
    {
      schema: {
        // querystring 스키마가 있으면 Fastify가 문자열 "50"을 숫자 50으로 바꾸고,
        // 범위 밖이면 우리가 코드를 안 써도 400을 돌려준다.
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
        }),
        response: { 200: Type.Array(TraceSchema) },
      },
    },
    async (req) => {
      const rows = await listTraces(req.query.limit)
      return rows.map((t) => ({ ...t, startedAt: t.startedAt.toISOString() }))
    },
  )
}

export async function listTraces(limit = 100): Promise<Trace[]> {
  return db.select().from(traces).orderBy(desc(traces.id)).limit(limit)
}

export function tracePlugin(app: FastifyInstance) {
  // Fastify에는 Express식 미들웨어 체인이 없고 이름 붙은 라이프사이클 훅이 있다.
  // onRequest(가장 이른 지점)에서 시각을 찍고, onResponse(응답 전송 후)에서
  // 소요 시간을 계산한다. 응답 뒤에 측정하므로 측정 자체가 응답 지연을 만들지 않는다.
  app.addHook('onRequest', async (req) => {
    req.startTime = process.hrtime.bigint()
    req.startedAt = new Date()
  })

  app.addHook('onResponse', async (req, reply) => {
    // 트레이스 목록 엔드포인트 자신은 제외한다. 안 그러면 대시보드 폴링이
    // 자기가 보여주는 데이터를 스스로 채워버린다.
    if (req.routeOptions.url === '/traces') return

    const durationNs = process.hrtime.bigint() - req.startTime

    // 응답은 이미 나갔으므로 여기서 던진 에러는 클라이언트에 닿지 않는다.
    // Fastify가 로그만 남기고 삼킨다. DB가 죽어 있으면 트레이스만 조용히 유실된다.
    await db.insert(traces).values({
      requestId: req.id,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      durationMs: Number(durationNs / 1_000_000n),
      startedAt: req.startedAt,
    })
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    startTime: bigint
    startedAt: Date
  }
}
