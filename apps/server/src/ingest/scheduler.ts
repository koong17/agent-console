import { Type } from 'typebox'
import { and, desc, eq, lt } from 'drizzle-orm'
import type { App } from '../app.js'
import { db } from '../db/index.js'
import { ingestRuns } from '../db/schema.js'
import { DateTime, Nullable } from '../schemas.js'
import { ingestAll } from './index.js'

// ingestion을 서버 프로세스 안에서 주기적으로 돈다.
//
// 이 선택의 대가를 알고 시작한다: 요청 처리와 ingestion이 같은 프로세스, 같은 스레드를
// 쓴다. ingestion이 파일을 파싱하는 동안(CPU) 요청 응답이 밀리고, 그 지연은 /traces에
// 그대로 찍힌다. 그게 눈에 띄게 커지는 순간이 작업을 별도 프로세스(큐)로 빼는 시점이다.

const INTERVAL_MS = 60 * 60 * 1000 // 1시간
// 정상 실행은 수 초다. 이보다 오래 running이면 끝을 기록하지 못한 채 죽은 것으로 본다.
const STALE_MS = 10 * 60 * 1000 // 10분

type Trigger = 'startup' | 'interval' | 'manual'

const IngestRun = Type.Object({
  id: Type.Integer(),
  trigger: Type.Union([Type.Literal('startup'), Type.Literal('interval'), Type.Literal('manual')]),
  status: Type.Union([Type.Literal('running'), Type.Literal('done'), Type.Literal('failed')]),
  startedAt: DateTime,
  finishedAt: Nullable(DateTime),
  files: Nullable(Type.Integer()),
  turns: Nullable(Type.Integer()),
  skills: Nullable(Type.Integer()),
  gates: Nullable(Type.Integer()),
  error: Nullable(Type.String()),
})

const IngestStatus = Type.Object({
  // 지금 돌고 있는 실행. 없으면 null.
  current: Nullable(IngestRun),
  // 최근 실행 10개, 새것부터. current도 포함된다.
  recent: Type.Array(IngestRun),
})

type Options = {
  // false면 라우트만 등록하고 타이머와 시작 시 실행은 붙이지 않는다.
  // openapi-emit이 이 모드로 조립한다. 라우트는 항상 있어야 스펙에 /ingest/* 가 들어간다.
  schedule?: boolean
}

// 오래 running인 행을 failed로 닫는다. 시작 시 정리는 "프로세스가 하나"라는 가정에 기대는데,
// tsx watch가 빠르게 두 번 재시작하면 두 프로세스가 겹쳐 그 가정이 깨진다(2026-09-08 관찰).
// 시간 기준은 그 가정이 없어도 동작한다. 멱등이라 자주 불러도 된다.
async function closeStaleRuns() {
  await db
    .update(ingestRuns)
    .set({ status: 'failed', finishedAt: new Date(), error: `stale: no finish within ${STALE_MS / 60000}m` })
    .where(and(eq(ingestRuns.status, 'running'), lt(ingestRuns.startedAt, new Date(Date.now() - STALE_MS))))
}

export function ingestScheduler(app: App, { schedule = true }: Options = {}) {
  // 겹침 방지는 여전히 메모리 플래그다. 프로세스가 하나라 이걸로 충분하고,
  // DB로 하려면 "running 행이 있나" 조회와 삽입 사이의 틈을 따로 막아야 한다.
  let running = false

  async function run(trigger: Trigger) {
    if (running) {
      app.log.warn({ trigger }, 'ingest skipped: previous run still in progress')
      return
    }
    running = true
    await closeStaleRuns()

    const [row] = await db
      .insert(ingestRuns)
      .values({ trigger, status: 'running', startedAt: new Date() })
      .returning({ id: ingestRuns.id })
    const id = row!.id

    try {
      const s = await ingestAll()
      await db
        .update(ingestRuns)
        .set({
          status: 'done',
          finishedAt: new Date(),
          files: s.files,
          turns: s.turns,
          skills: s.skills,
          gates: s.gates,
        })
        .where(eq(ingestRuns.id, id))
      app.log.info({ trigger, ...s }, 'ingest done')
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await db
        .update(ingestRuns)
        .set({ status: 'failed', finishedAt: new Date(), error })
        .where(eq(ingestRuns.id, id))
      app.log.error({ trigger, error }, 'ingest failed')
    } finally {
      running = false
    }
  }

  if (schedule)
    app.addHook('onReady', async () => {
      // 이전 프로세스가 실행 중에 죽었으면 그 줄이 running으로 영원히 남는다.
      // 프로세스가 하나뿐이므로 시작 시점에 running인 줄은 전부 고아다. failed로 닫는다.
      await db
        .update(ingestRuns)
        .set({ status: 'failed', finishedAt: new Date(), error: 'process restarted mid-run' })
        .where(eq(ingestRuns.status, 'running'))

      // 서버가 뜨면 한 번, 그 뒤 1시간마다.
      // unref(): 이 타이머 때문에 프로세스가 종료를 못 하는 일이 없게 한다.
      void run('startup')
      setInterval(() => void run('interval'), INTERVAL_MS).unref()
    })

  app.get('/ingest/status', { schema: { response: { 200: IngestStatus } } }, async () => {
    // 읽기 엔드포인트에서 쓰기를 하는 예외. 안 하면 실행 주기(1시간) 동안 화면이 "실행 중"으로 굳는다.
    await closeStaleRuns()
    const recent = await db.select().from(ingestRuns).orderBy(desc(ingestRuns.id)).limit(10)
    return { current: recent.find((r) => r.status === 'running') ?? null, recent }
  })

  // 수동 트리거. 기다리지 않고 바로 응답한다. 결과는 /ingest/status로 확인.
  // 기다리면 요청 하나가 몇 초를 점유하고, 그 시간이 /traces에 ingestion 비용으로 잡혀
  // 진짜 요청 지연과 구분이 안 된다.
  app.post(
    '/ingest/run',
    { schema: { response: { 202: Type.Object({ accepted: Type.Literal(true) }) } } },
    async (_req, reply) => {
      void run('manual')
      return reply.code(202).send({ accepted: true })
    },
  )
}
