import { Type } from 'typebox'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { App } from '../app.js'
import { db } from '../db/index.js'
import { ingestRuns, messages } from '../db/schema.js'
import { DateTime, Nullable } from '../schemas.js'
import { ingestAll, unexplained, unknownTypes } from './index.js'

// ingestion을 서버 프로세스 안에서 주기적으로 돈다.
//
// 이 선택의 대가를 알고 시작한다: 요청 처리와 ingestion이 같은 프로세스, 같은 스레드를
// 쓴다. ingestion이 파일을 파싱하는 동안(CPU) 요청 응답이 밀리고, 그 지연은 /traces에
// 그대로 찍힌다. 그게 눈에 띄게 커지는 순간이 작업을 별도 프로세스(큐)로 빼는 시점이다.

const INTERVAL_MS = 60 * 60 * 1000 // 1시간
// running 인 채로 이만큼 지나면 끝을 기록하지 못하고 죽은 것으로 본다.
//
// 처음엔 10분이었고 주석에 "정상 실행은 수 초다"라고 적혀 있었다. 이 환경에서는 거짓이다.
// 2026-09-29 측정(성공 실행 531건): p95 6.5초인데 최대 1048초(17.5분), 10분 초과가 10건.
// 전부 interval 실행이고 새벽·유휴 시간대이며 넣은 행은 0이다 — 부하가 아니라 macOS 가
// 백그라운드 프로세스를 조이는 것이다. 벽시계 시간은 프로세스 생존의 좋은 대리 지표가 아니다.
//
// 그래서 값을 두 조건 사이에서 고른다.
//   관측된 정상 실행 최댓값(17.5분) 위   — 살아 있는 실행을 failed 로 찍지 않는다
//   실행 주기(60분) 아래                  — 고아 행이 다음 실행 전에 정리된다
// 30분이면 둘 다 만족하고, 30분을 넘긴 성공 실행은 531건 중 0건이다.
//
// 이래도 heuristic 이다. OS 가 30분 넘게 재우면 또 틀린다. 그 피해는 아래 run() 이
// 성공 시 error 를 null 로 덮어 스스로 교정하는 것으로 막는다.
const STALE_MS = 30 * 60 * 1000 // 30분

// 사람 메시지 침묵 경보의 기준. 에이전트 글은 들어오는데 사람이 친 메시지가 0건인 활동일이
// 이만큼 쌓이면 울린다.
//
// 왜 필요한가: 사람 메시지 판정은 transcript 의 origin 필드에 기댄다(transcripts.ts userKind).
// Claude Code 가 이 필드를 없애면 줄은 여전히 아는 type(user)이고 JSON 도 멀쩡해서
// unexplained 는 0 그대로다. 매일 수천 줄씩 정상적으로 빠지는 도구 응답 사이에 섞여 조용히 사라진다.
// 그래서 줄 단위가 아니라 결과의 모양으로 본다 — 에이전트는 사람이 말을 걸어야 답하므로
// "에이전트 글은 있는데 사람 말이 없는 날"은 정상적으로는 거의 생기지 않는다.
//
// 1인 이유: 2026-09-30 전 기간을 날짜별로 쟀을 때 이런 날은 0일이었다. 한 번이면 이미 이상이다.
// 알고 받아들이는 오탐: "/feature-plan" 같은 명령만으로 돌린 날. 명령은 typed 가 아니다.
// 명령을 사람 입력으로 같이 세면 그 오탐은 사라지지만, origin 이 사라진 날 명령을 하나라도
// 쳤으면 경보가 가려진다. 이 경보가 잡으려는 게 origin 고장이라 typed 만 센다.
//
// 전제: 자동 작업(claude -p)은 transcript 를 남기지 않는다(run-evals.mjs 의 --no-session-persistence).
// 로드맵 1단계의 작업 실행기가 세션을 남기게 되면 그 세션은 사람 없이 글만 쌓으므로 여기서 빼야 한다.
const TYPED_SILENT_DAYS = 1

type Trigger = 'startup' | 'interval' | 'manual'

// DB에는 jsonb 한 덩어리지만 계약에서는 필드를 전부 못박는다.
// 그래야 웹이 카운터 이름을 오타 없이 쓰고, 카운터가 바뀌면 contract:check 가 잡는다.
//
// 나중에 생긴 카운터는 Optional 이다. stats 는 버전이 섞인 덩어리라서 — 이 라우트는
// 최근 실행 10개를 돌려주는데, 카운터가 생기기 전에 돌았던 행에는 그 키가 없다.
// 필수로 두면 옛 행 하나 때문에 응답 전체가 500 이 된다(2026-09-29 실제로 터졌다).
// 새 실행이 10번 쌓이면 저절로 사라지는 종류라 더 위험하다 — 방금 짠 사람은 못 보고
// 나중에 옛 행을 보는 사람만 본다. 카운터를 추가하면 여기도 Optional 로 넣는다.
const IngestStatsSchema = Type.Object({
  transcripts: Type.Object({
    lines: Type.Integer(),
    badJson: Type.Integer(),
    filesEmpty: Type.Integer(),
    // 키가 데이터에서 나오는 유일한 필드. 타입 이름을 미리 못 박을 수 없어서 Record 다.
    typeCounts: Type.Record(Type.String(), Type.Integer()),
    unknownTypeLines: Type.Integer(),
    toolResults: Type.Optional(Type.Integer()),
    toolResultsUnmatched: Type.Optional(Type.Integer()),
    assistantLines: Type.Integer(),
    synthetic: Type.Integer(),
    unusable: Type.Integer(),
  }),
  events: Type.Object({
    lines: Type.Integer(),
    badJson: Type.Integer(),
    skillLines: Type.Integer(),
    unknownType: Type.Integer(),
    incomplete: Type.Integer(),
    memoryDeny: Type.Optional(Type.Integer()),
  }),
})

const IngestRun = Type.Object({
  id: Type.Integer(),
  trigger: Type.Union([Type.Literal('startup'), Type.Literal('interval'), Type.Literal('manual')]),
  status: Type.Union([Type.Literal('running'), Type.Literal('done'), Type.Literal('failed')]),
  startedAt: DateTime,
  finishedAt: Nullable(DateTime),
  files: Nullable(Type.Integer()),
  turns: Nullable(Type.Integer()),
  turnsUpdated: Nullable(Type.Integer()),
  skills: Nullable(Type.Integer()),
  gates: Nullable(Type.Integer()),
  decisions: Nullable(Type.Integer()),
  messages: Nullable(Type.Integer()),
  // 이 열이 생기기 전 실행(그리고 running/failed 행)은 null 이다.
  stats: Nullable(IngestStatsSchema),
  // stats 에서 계산한 값. 열이 아니라 응답에서 만든다.
  // 웹에서 같은 덧셈을 다시 쓰면 "무엇이 비정상인가"의 정의가 두 곳으로 갈라진다.
  unexplained: Nullable(Type.Integer()),
  // 처음 보는 type 이름들. 비어 있으면 B형 고장은 아니라는 뜻.
  unknownTypes: Type.Array(Type.String()),
  error: Nullable(Type.String()),
})

const IngestStatus = Type.Object({
  // 지금 돌고 있는 실행. 없으면 null.
  current: Nullable(IngestRun),
  // 최근 실행 10개, 새것부터. current도 포함된다.
  recent: Type.Array(IngestRun),
  // 실행 하나가 아니라 쌓인 결과 전체에 대한 판정이라 recent 옆에 따로 둔다.
  typedSilence: Type.Object({
    lastTypedAt: Nullable(DateTime),
    // 마지막 사람 메시지가 있던 날 이후, 에이전트 글(메인 대화)이 있었던 날 수.
    silentActiveDays: Type.Integer(),
    threshold: Type.Integer(),
    alarm: Type.Boolean(),
  }),
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
          turnsUpdated: s.turnsUpdated,
          skills: s.skills,
          gates: s.gates,
          decisions: s.decisions,
          messages: s.messages,
          stats: s.stats,
          // 성공했으면 error 를 지운다. 안 지우면 stale 정리나 재시작 정리가 먼저
          // 찍어둔 메시지가 남아 "done 인데 오류가 달린 행"이 된다(2026-09-29 실제 1건).
          // 이 한 줄이 스스로 교정하는 부분이다 — 살아 있는 실행을 잘못 failed 로 찍어도
          // 완료되는 순간 status 와 error 가 함께 정상으로 돌아온다.
          error: null,
        })
        .where(eq(ingestRuns.id, id))
      app.log.info({ trigger, ...s, unexplained: unexplained(s.stats) }, 'ingest done')
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
    const rows = await db.select().from(ingestRuns).orderBy(desc(ingestRuns.id)).limit(10)
    const recent = rows.map((r) => ({
      ...r,
      unexplained: r.stats ? unexplained(r.stats) : null,
      unknownTypes: r.stats ? unknownTypes(r.stats) : [],
    }))

    // 활동일은 "메인 대화에 에이전트 글이 있는 날"이다. 서브에이전트 글은 사람과 무관하게
    // 부모가 띄우므로 뺀다. 사람 메시지가 한 번도 없으면(null) 에이전트 글이 있는 모든 날을 센다 —
    // 처음부터 origin 을 못 읽는 경우도 같은 고장이다.
    const silence = await db.execute<{ last_typed_at: string | null; silent_active_days: number }>(sql`
      with last_typed as (select max(${messages.ts}) as t from ${messages} where ${messages.kind} = 'typed')
      select
        (select t from last_typed) as last_typed_at,
        (
          select count(distinct ${messages.ts}::date)::int from ${messages}
          where ${messages.kind} = 'assistant' and not ${messages.sidechain}
            and ((select t from last_typed) is null or ${messages.ts}::date > (select t from last_typed)::date)
        ) as silent_active_days
    `)
    const t = silence.rows[0]
    const silentActiveDays = Number(t?.silent_active_days ?? 0)

    return {
      current: recent.find((r) => r.status === 'running') ?? null,
      recent,
      typedSilence: {
        lastTypedAt: t?.last_typed_at ?? null,
        silentActiveDays,
        threshold: TYPED_SILENT_DAYS,
        alarm: silentActiveDays >= TYPED_SILENT_DAYS,
      },
    }
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
