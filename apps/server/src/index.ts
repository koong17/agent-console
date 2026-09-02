import Fastify from 'fastify'
import { tracePlugin, listTraces } from './trace.js'

const app = Fastify({ logger: true })

tracePlugin(app)

// A couple of routes to observe. /slow exists so the first chart has
// something interesting to show: a visible latency outlier.
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
