import type { FastifyInstance } from 'fastify'

// One row per finished HTTP request. This is the self-observation unit:
// everything the dashboard will ever chart hangs off this shape.
export type Trace = {
  id: string
  method: string
  url: string
  statusCode: number
  durationMs: number
  startedAt: string
}

// In-memory ring buffer, newest first, capped so a long-running dev server
// cannot grow without bound. Milestone 2 replaces this with Postgres —
// the plugin's surface (record/list) is the part that survives that swap.
const MAX_TRACES = 1000
const traces: Trace[] = []

export function listTraces(limit = 100): Trace[] {
  return traces.slice(0, limit)
}

export function tracePlugin(app: FastifyInstance) {
  // Fastify has no Express-style middleware chain; it exposes named
  // lifecycle hooks instead. We stamp the clock at onRequest (earliest
  // point) and compute duration at onResponse (after the reply is sent,
  // so measuring adds no latency to the response itself).
  app.addHook('onRequest', async (req) => {
    req.startTime = process.hrtime.bigint()
  })

  app.addHook('onResponse', async (req, reply) => {
    // The trace list endpoint itself is excluded: otherwise polling the
    // dashboard would flood the very data it displays.
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
