import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, eq } from 'drizzle-orm'
import { db, pool } from '../db/index.js'
import { decisions, decisionKinds, llmJobs, questionKinds } from '../db/schema.js'
import { claim, drain, enqueue, recoverStale } from './runner.js'
import { KIND, enqueueUnclassified, questionKindHandler } from './question-kind.js'

// 진짜 claude 를 부르지 않는다. 대신 PATH 맨 앞에 가짜 `claude` 실행 파일을 둔다.
//
// 프로덕션 코드에 "테스트용 ask 주입" 자리를 만들지 않는 이유는 ingest-file.test.ts 와 같다.
// 이렇게 하면 execFile, 인자 조립, JSON 파싱, 종료 코드 처리까지 진짜 경로가 그대로 돈다.
// 가짜는 받은 인자를 파일로 남기고, 미리 적어 둔 답을 순서대로 하나씩 돌려준다.

let dir: string
const fakeClaude = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const dir = process.env.FAKE_CLAUDE_DIR
const n = fs.readdirSync(path.join(dir, 'calls')).length
fs.writeFileSync(path.join(dir, 'calls', n + '.json'), JSON.stringify(process.argv.slice(2)))
const replies = JSON.parse(fs.readFileSync(path.join(dir, 'replies.json'), 'utf8'))
process.stdout.write(JSON.stringify(replies[n] ?? { is_error: true, result: 'no reply prepared' }))
`

async function replies(list: unknown[]) {
  await writeFile(join(dir, 'replies.json'), JSON.stringify(list))
}
const ok = (structured: unknown, cost = 0.001) => ({
  is_error: false,
  result: JSON.stringify(structured),
  structured_output: structured,
  total_cost_usd: cost,
  modelUsage: { 'claude-haiku-4-5-20251001': {} },
})
// 가짜가 받은 호출의 마지막 인자(프롬프트)들.
async function prompts() {
  const files = (await readdir(join(dir, 'calls'))).sort((a, b) => parseInt(a) - parseInt(b))
  return Promise.all(files.map(async (f) => (JSON.parse(await readFile(join(dir, 'calls', f), 'utf8')) as string[]).at(-1)!))
}

async function decision(question: string, ts: string) {
  const [row] = await db
    .insert(decisions)
    .values({ sessionId: 's1', ts: new Date(ts), header: '', question, options: ['예 (추천)', '아니오'] })
    .returning({ id: decisions.id })
  return row!.id
}

describe('LLM 작업 실행기 (DB)', () => {
  before(async () => {
    const rows = (await db.execute<{ name: string }>(sql`select current_database() as name`)).rows
    const name = rows[0]?.name ?? '(알 수 없음)'
    assert.match(name, /_test$/, `테스트 DB 가 아닙니다(${name}).`)
    dir = await mkdtemp(join(tmpdir(), 'agent-console-jobs-'))
    await writeFile(join(dir, 'claude'), fakeClaude)
    await chmod(join(dir, 'claude'), 0o755)
    process.env.FAKE_CLAUDE_DIR = dir
    process.env.PATH = `${dir}:${process.env.PATH}`
  })

  beforeEach(async () => {
    await db.execute(sql`truncate ${decisionKinds}, ${questionKinds}, ${llmJobs}, ${decisions} restart identity cascade`)
    await rm(join(dir, 'calls'), { recursive: true, force: true })
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'calls')))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
    await pool.end()
  })

  test('같은 대상은 두 번 넣어도 작업이 하나다', async () => {
    assert.equal(await enqueue(KIND, [{ subject: '1', input: {} }]), 1)
    assert.equal(await enqueue(KIND, [{ subject: '1', input: {} }]), 0)
    assert.equal((await db.select().from(llmJobs)).length, 1)
  })

  // 순서대로 돌아야 하는 이유 그 자체. 두 번째 작업의 프롬프트에 첫 작업이 만든 종류가 들어 있어야 한다.
  test('뒤 작업은 앞 작업이 만든 종류를 보고 재사용한다', async () => {
    const a = await decision('커밋할까요?', '2026-09-01T00:00:00Z')
    const b = await decision('이 변경 커밋해도 될까요?', '2026-09-02T00:00:00Z')
    await replies([
      ok({ kind: '커밋 승인', description: '변경을 커밋할지 정한다.' }),
      ok({ kind: '커밋 승인', description: '무시되어야 하는 두 번째 설명' }),
    ])

    assert.equal(await enqueueUnclassified(), 2)
    const s = await drain(questionKindHandler)

    assert.deepEqual([s.done, s.failed], [2, 0])
    assert.equal(s.costUsd.toFixed(3), '0.002')
    const [p1, p2] = await prompts()
    assert.match(p1!, /\(none yet\)/)
    assert.match(p2!, /- 커밋 승인: 변경을 커밋할지 정한다\./)
    // 답(chosen)은 프롬프트에 없다. 선택지는 있다.
    assert.match(p2!, /options: 예 \(추천\) \| 아니오/)
    const kinds = await db.select().from(questionKinds)
    assert.equal(kinds.length, 1)
    assert.equal(kinds[0]!.description, '변경을 커밋할지 정한다.') // 첫 설명이 기준으로 남는다
    const dk = await db.select().from(decisionKinds).orderBy(decisionKinds.decisionId)
    assert.deepEqual(dk.map((r) => [r.decisionId, r.kind]), [[a, '커밋 승인'], [b, '커밋 승인']])
    const [job] = await db.select().from(llmJobs).where(eq(llmJobs.subject, String(a)))
    assert.equal(job!.model, 'claude-haiku-4-5-20251001') // 별칭이 아니라 실제 모델 이름
    assert.equal(job!.status, 'done')
  })

  test('claude 가 오류를 돌려주면 failed 로 남고 파생 표는 비어 있다', async () => {
    await decision('커밋할까요?', '2026-09-01T00:00:00Z')
    await replies([{ is_error: true, result: 'rate limited' }])

    await enqueueUnclassified()
    const s = await drain(questionKindHandler)

    assert.deepEqual([s.done, s.failed], [0, 1])
    const [job] = await db.select().from(llmJobs)
    assert.equal(job!.status, 'failed')
    assert.match(job!.error!, /rate limited/)
    assert.ok(job!.prompt) // 실패해도 보낸 프롬프트는 남는다
    assert.equal((await db.select().from(decisionKinds)).length, 0)
  })

  // done 표시와 파생 표 반영이 한 트랜잭션이라는 것. 반영이 실패하면 done 도 없어야 한다.
  // 없는 결정 id 로 넣어 decision_kinds 의 FK 가 거부하게 만든다. 그 전에 question_kinds 에는
  // 새 종류가 들어간 상태라, 롤백이 안 되면 주인 없는 종류가 남는다.
  test('반영이 실패하면 done 도, 새 종류도 남지 않는다', async () => {
    await enqueue(KIND, [{ subject: '999999', input: { header: '', question: 'q', options: [] } }])
    await replies([ok({ kind: '고아 종류', description: '남으면 안 된다.' })])

    const s = await drain(questionKindHandler)

    assert.equal(s.failed, 1)
    const [job] = await db.select().from(llmJobs)
    assert.equal(job!.status, 'failed')
    // 원인(FK 위반)이 cause 에서 이어 붙어 남는다. "Failed query" 만으로는 원인을 모른다.
    assert.match(job!.error!, /cause: .*foreign key/)
    assert.equal((await db.select().from(questionKinds)).length, 0)
  })

  // SKIP LOCKED. 다른 실행기가 행을 잡고 있는 동안 claim 이 그 행을 건너뛰고 다음 것을 가져와야 한다.
  //
  // Promise.all 로 claim 두 번을 부르는 것으로는 이걸 못 보인다 — 한 문장이 너무 빨리 끝나서
  // 실제로는 차례로 돈다(처음엔 그렇게 썼고, SKIP LOCKED 를 지워도 통과했다).
  // 그래서 트랜잭션 안에서 1번 행을 잠근 채로 둔 상태를 만들고 그 사이에 claim 을 부른다.
  // SKIP LOCKED 가 없으면 claim 은 잠금이 풀릴 때까지 기다린다. 1초 안에 안 오면 실패로 본다.
  test('다른 쪽이 잡고 있는 행은 건너뛰고 다음 작업을 받는다', async () => {
    await enqueue(KIND, [
      { subject: '1', input: {} },
      { subject: '2', input: {} },
    ])

    const got = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from ${llmJobs} where subject = '1' for update`)
      return Promise.race([
        claim(KIND),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1000)),
      ])
    })

    assert.notEqual(got, 'blocked', 'claim 이 잠긴 행을 기다렸다 — SKIP LOCKED 가 없다')
    assert.equal((got as { subject: string }).subject, '2')
  })

  test('제한 시간을 넘긴 running 만 대기열로 돌아간다', async () => {
    await enqueue(KIND, [
      { subject: 'old', input: {} },
      { subject: 'new', input: {} },
    ])
    await db.update(llmJobs).set({ status: 'running', startedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(llmJobs.subject, 'old'))
    await db.update(llmJobs).set({ status: 'running', startedAt: new Date() }).where(eq(llmJobs.subject, 'new'))

    assert.equal(await recoverStale(), 1)
    const rows = Object.fromEntries((await db.select().from(llmJobs)).map((r) => [r.subject, r.status]))
    assert.deepEqual(rows, { old: 'queued', new: 'running' })
  })
})
