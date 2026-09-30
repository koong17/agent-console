// LLM 작업 실행기. llm_jobs 표를 큐로 쓴다.
//
// 흐름: enqueue 가 queued 행을 넣고 → drain 이 하나씩 꺼내(claim) → handler 로 프롬프트를 만들어
// claude -p 를 부르고 → 결과를 저장하면서 handler.apply 로 파생 표에 반영한다.
//
// BullMQ(Redis) 대신 Postgres 표인 이유: 이미 있는 저장소이고, 작업 수가 수백 건 단위다.
// 필요한 성질(안 잃어버림, 두 번 안 함, 동시에 둘이 같은 걸 안 집음)은 전부 SQL 로 얻는다.
// milestone 5 의 큐가 필요해지는 신호는 "느려서"가 아니라 여러 프로세스·머신이 나눠 돌려야 할 때다.

import { and, eq, lt, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { llmJobs, type LlmJob } from '../db/schema.js'
import { ask, ASK_TIMEOUT_MS } from './claude.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// 작업 종류 하나의 정의. 종류별 파일(question-kind.ts 등)이 이 모양을 채운다.
export type Handler<I, O> = {
  kind: string
  model: string
  jsonSchema: object
  // 실행 시점에 프롬프트를 만든다. 넣을 때 만들지 않는 이유: 프롬프트가 그 순간의 DB 상태
  // (지금까지 생긴 질문 종류 목록 등)에 기대기 때문이다.
  prompt(input: I): Promise<{ system: string; prompt: string }>
  // 결과를 파생 표에 반영한다. 작업을 done 으로 바꾸는 것과 같은 트랜잭션 안에서 돈다 —
  // "done 인데 반영 안 됨"이나 "반영됐는데 queued" 같은 반쪽 상태가 없다.
  apply(tx: Tx, job: LlmJob, output: O): Promise<void>
}

// 같은 (kind, subject) 가 이미 있으면 건너뛴다. 이게 "같은 대상에 두 번 돈 쓰지 않음"이다.
// 돌려주는 값은 새로 들어간 수.
export async function enqueue(kind: string, items: Array<{ subject: string; input: unknown }>) {
  if (items.length === 0) return 0
  const rows = await db
    .insert(llmJobs)
    .values(items.map((i) => ({ kind, subject: i.subject, input: i.input, status: 'queued' as const })))
    .onConflictDoNothing()
    .returning({ id: llmJobs.id })
  return rows.length
}

// 실행 중에 프로세스가 죽으면 running 행이 영원히 남는다. 되살린다.
//
// 기준 시간은 호출 제한 시간의 두 배다. execFile 이 ASK_TIMEOUT_MS 에 자식을 죽이므로
// 살아 있는 실행은 그보다 오래 running 일 수 없다. 두 배는 DB 쓰기 여유다.
// 적재의 stale 기준(30분)은 관측값에서 골라야 했지만, 여기는 제한 시간이 코드에 있어서 유도된다.
export async function recoverStale() {
  const rows = await db
    .update(llmJobs)
    .set({ status: 'queued', startedAt: null })
    .where(and(eq(llmJobs.status, 'running'), lt(llmJobs.startedAt, new Date(Date.now() - 2 * ASK_TIMEOUT_MS))))
    .returning({ id: llmJobs.id })
  return rows.length
}

// 실패한 작업을 다시 대기열로. 자동 재시도는 하지 않는다 — 프롬프트나 스키마가 틀려서
// 실패한 거면 같은 실패에 돈을 계속 쓴다. 사람이 원인을 보고 다시 넣는다.
export async function retryFailed(kind: string) {
  const rows = await db
    .update(llmJobs)
    .set({ status: 'queued', error: null })
    .where(and(eq(llmJobs.kind, kind), eq(llmJobs.status, 'failed')))
    .returning({ id: llmJobs.id })
  return rows.length
}

// 가장 오래 기다린 queued 하나를 running 으로 바꾸고 가져온다. 한 문장이다.
//
// FOR UPDATE SKIP LOCKED 가 핵심이다. 두 실행기가 동시에 이 문장을 돌리면, 먼저 온 쪽이 행을
// 잠그고 뒤에 온 쪽은 그 행을 "건너뛰고" 다음 행을 잡는다. 잠금 없이 select 후 update 하면
// 둘 다 같은 행을 보고 같은 작업을 두 번 돌린다(두 번 돈이 나간다).
// 지금은 실행기가 하나지만, CLI 와 서버가 겹쳐 도는 순간이 생기면 이게 막는다.
export async function claim(kind: string): Promise<LlmJob | null> {
  const result = await db.execute<LlmJob>(sql`
    update ${llmJobs}
    set status = 'running', started_at = now(), attempts = attempts + 1
    where id = (
      select id from ${llmJobs}
      where kind = ${kind} and status = 'queued'
      order by id
      limit 1
      for update skip locked
    )
    returning id, kind, subject, status, input, attempts
  `)
  const row = result.rows[0]
  return row ? (row as LlmJob) : null
}

// 작업 하나를 끝까지 돌린다. 실패는 던지지 않고 failed 로 기록한다 —
// 한 건의 실패로 drain 전체가 멈추면 안 된다.
export async function runJob<I, O>(handler: Handler<I, O>, job: LlmJob) {
  let prompt: string | null = null
  try {
    const p = await handler.prompt(job.input as I)
    prompt = p.prompt
    const r = await ask({ model: handler.model, systemPrompt: p.system, prompt: p.prompt, jsonSchema: handler.jsonSchema })
    if (r.structured === null) throw new Error('structured_output 이 비어 있다')
    await db.transaction(async (tx) => {
      await tx
        .update(llmJobs)
        .set({
          status: 'done',
          finishedAt: new Date(),
          model: r.model ?? handler.model,
          prompt,
          output: r.structured,
          costUsd: String(r.costUsd),
          error: null,
        })
        .where(eq(llmJobs.id, job.id))
      await handler.apply(tx, job, r.structured as O)
    })
    return { ok: true as const, costUsd: r.costUsd }
  } catch (err) {
    // Drizzle 은 Postgres 원문을 cause 에 감싼다. 메시지만 남기면 "Failed query: ..." 뿐이라
    // 원인을 모른다(2026-09-30 ingest_runs 에서 실제로 겪었다). cause 까지 이어 붙인다.
    const e = err as Error & { cause?: unknown }
    const error = [e.message ?? String(err), e.cause instanceof Error ? `cause: ${e.cause.message}` : null]
      .filter(Boolean)
      .join('\n')
    await db
      .update(llmJobs)
      .set({ status: 'failed', finishedAt: new Date(), prompt, error })
      .where(eq(llmJobs.id, job.id))
    return { ok: false as const, error }
  }
}

export type DrainSummary = { done: number; failed: number; costUsd: number }

// 대기열이 빌 때까지(또는 limit 까지) 하나씩 돌린다.
//
// 동시에 여러 개를 돌리지 않는다. 느려서가 아니라 결과가 달라져서다. question-kind 는
// 앞 작업이 만든 종류 목록을 보고 다음 작업이 분류한다. 둘을 동시에 돌리면 둘 다 "아직 없는
// 종류"를 보고 같은 뜻의 종류를 다른 이름으로 하나씩 만든다. 순서가 결과의 일부인 작업이다.
export async function drain<I, O>(handler: Handler<I, O>, { limit = Infinity } = {}): Promise<DrainSummary> {
  const summary: DrainSummary = { done: 0, failed: 0, costUsd: 0 }
  for (let n = 0; n < limit; n++) {
    const job = await claim(handler.kind)
    if (!job) break
    const r = await runJob(handler, job)
    if (r.ok) {
      summary.done++
      summary.costUsd += r.costUsd
    } else summary.failed++
  }
  return summary
}
