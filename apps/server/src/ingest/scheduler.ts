import type { FastifyInstance } from 'fastify'
import { ingestTranscripts, type IngestSummary } from './transcripts.js'

// ingestion을 서버 프로세스 안에서 주기적으로 돈다.
//
// 이 선택의 대가를 알고 시작한다: 요청 처리와 ingestion이 같은 프로세스, 같은 스레드를
// 쓴다. ingestion이 파일을 파싱하는 동안(CPU) 요청 응답이 밀리고, 그 지연은 /traces에
// 그대로 찍힌다. 그게 눈에 띄게 커지는 순간이 작업을 별도 프로세스(큐)로 빼는 시점이다.

const INTERVAL_MS = 60 * 60 * 1000 // 1시간

type RunState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string }
  | { status: 'done'; finishedAt: string; summary: IngestSummary }
  | { status: 'failed'; finishedAt: string; error: string }

// 프로세스 메모리에만 있다. 재시작하면 idle로 돌아간다.
let state: RunState = { status: 'idle' }

export function ingestScheduler(app: FastifyInstance) {
  async function run(trigger: 'startup' | 'interval' | 'manual') {
    // 이전 실행이 아직 안 끝났으면 겹쳐 돌리지 않는다. 같은 파일을 두 트랜잭션이
    // 동시에 넣으면 한쪽이 키 충돌로 대기하거나 실패한다.
    if (state.status === 'running') {
      app.log.warn({ trigger }, 'ingest skipped: previous run still in progress')
      return state
    }
    state = { status: 'running', startedAt: new Date().toISOString() }
    try {
      const summary = await ingestTranscripts()
      state = { status: 'done', finishedAt: new Date().toISOString(), summary }
      app.log.info({ trigger, ...summary }, 'ingest done')
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      state = { status: 'failed', finishedAt: new Date().toISOString(), error }
      app.log.error({ trigger, error }, 'ingest failed')
    }
    return state
  }

  // 서버가 뜨면 한 번, 그 뒤 1시간마다.
  // unref(): 이 타이머 때문에 프로세스가 종료를 못 하는 일이 없게 한다.
  app.addHook('onReady', async () => {
    void run('startup')
    setInterval(() => void run('interval'), INTERVAL_MS).unref()
  })

  app.get('/ingest/status', async () => state)

  // 수동 트리거. 기다리지 않고 바로 응답한다. 결과는 /ingest/status로 확인.
  // 기다리면 요청 하나가 몇 초를 점유하고, 그 시간이 /traces에 ingestion 비용으로 잡혀
  // 진짜 요청 지연과 구분이 안 된다.
  app.post('/ingest/run', async (_req, reply) => {
    void run('manual')
    return reply.code(202).send({ accepted: true })
  })
}
