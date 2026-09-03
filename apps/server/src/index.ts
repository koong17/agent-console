import Fastify from 'fastify'
import { tracePlugin, listTraces } from './trace.js'
import { usageRoutes } from './usage.js'
import { ingestScheduler } from './ingest/scheduler.js'

const app = Fastify({ logger: true })

tracePlugin(app)
usageRoutes(app)
ingestScheduler(app)

// 관찰 대상 라우트 몇 개. /slow는 첫 차트에 볼 만한 게 있도록,
// 눈에 띄는 지연 이상치를 하나 만들어 두는 용도다.
app.get('/health', async () => ({ ok: true }))

app.get('/slow', async () => {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700))
  return { ok: true, note: 'deliberately slow' }
})

app.get('/traces', async (req) => {
  const { limit } = req.query as { limit?: string }
  return listTraces(limit ? Number(limit) : undefined)
})

const port = Number(process.env.PORT ?? 4000)
await app.listen({ port, host: '127.0.0.1' })
