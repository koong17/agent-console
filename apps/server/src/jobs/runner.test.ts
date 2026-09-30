import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, eq } from 'drizzle-orm'
import { db, pool } from '../db/index.js'
import { answerPolicies, correctionReplays, decisionPolicies, decisions, decisionKinds, draftThemes, evalDrafts, evalResults, evalRuns, llmJobs, messageIntents, messages, questionKinds, sessions, shadowPredictions } from '../db/schema.js'
import { claim, drain, enqueue, recoverStale } from './runner.js'
import { KIND, enqueueUnclassified, questionKindHandler } from './question-kind.js'

// 테스트 파일들이 같은 테스트 DB 의 표를 비운다(이 파일은 llm_jobs·decisions·messages,
// ingest-file.test.ts 는 sessions·messages). node --test 는 기본으로 파일마다 별도 프로세스를
// 동시에 띄우므로, 그대로 두면 한 파일의 truncate 가 다른 파일의 행을 테스트 도중에 지운다.
// 그래서 package.json 의 test 스크립트가 --test-concurrency=1 로 파일을 하나씩 돌린다.

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

async function decision(
  question: string,
  ts: string,
  over: Partial<typeof decisions.$inferInsert> = {},
) {
  const [row] = await db
    .insert(decisions)
    .values({ sessionId: 's1', ts: new Date(ts), header: '', question, options: ['예 (추천)', '아니오'], ...over })
    .returning({ id: decisions.id })
  return row!.id
}

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
  await db.execute(
    sql`truncate ${draftThemes}, ${evalDrafts}, ${decisionPolicies}, ${answerPolicies}, ${evalResults}, ${evalRuns}, ${correctionReplays}, ${messageIntents}, ${shadowPredictions}, ${decisionKinds}, ${questionKinds}, ${llmJobs}, ${decisions} restart identity cascade`,
  )
  await rm(join(dir, 'calls'), { recursive: true, force: true })
  await mkdir(join(dir, 'calls'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
  await pool.end()
})

describe('LLM 작업 실행기 (DB)', () => {
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

// 블라인드 재예측. 브레인 레포 대신 임시 git 레포를 만든다. 커밋 두 개에 sense.md 내용을 다르게 두고,
// 결정이 그 사이에 있으면 첫 커밋의 내용이 프롬프트에 들어가야 한다.
describe('shadow-predict', () => {
  let brain: string
  let sp: typeof import('./shadow-predict.js')
  const commitAt = async (text: string, iso: string) => {
    await writeFile(join(brain, 'identity', 'sense.md'), text)
    execFileSync('git', ['add', '-A'], { cwd: brain })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', text], {
      cwd: brain,
      env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    })
  }

  before(async () => {
    brain = await mkdtemp(join(tmpdir(), 'agent-console-brain-'))
    await mkdir(join(brain, 'identity'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: brain })
    await commitAt('OLD RULES\n- `BI-10` ask before commit', '2026-09-01T00:00:00Z')
    await commitAt('NEW RULES', '2026-09-20T00:00:00Z')
    // BRAIN_DIR 은 모듈이 읽힐 때 정해진다. 그래서 환경변수를 바꾼 뒤에 불러온다.
    process.env.BRAIN_DIR = brain
    sp = await import('./shadow-predict.js')
  })
  after(async () => {
    await rm(brain, { recursive: true, force: true })
  })

  test('채점할 수 있는 결정만 넣고, 표시는 지운다', async () => {
    await decision('단일', '2026-09-10T00:00:00Z', { chosen: '예 (추천)', multiSelect: false })
    await decision('복수', '2026-09-10T00:01:00Z', { chosen: '예 (추천)', multiSelect: true })
    await decision('직접 입력', '2026-09-10T00:02:00Z', { chosen: '다른 거', multiSelect: false })
    await decision('답 없음', '2026-09-10T00:03:00Z', { chosen: null, multiSelect: false })

    assert.equal(await sp.enqueueEligible(), 1)
    const [job] = await db.select().from(llmJobs)
    const input = job!.input as { options: string[]; chosen: string; question: string }
    assert.equal(input.question, '단일')
    assert.deepEqual(input.options, ['예', '아니오'])
    assert.equal(input.chosen, '예')
  })

  test('그 시점의 sense.md 로 묻고, 답과 추천은 프롬프트에 없다', async () => {
    const id = await decision('커밋할까요?', '2026-09-10T00:00:00Z', { chosen: '아니오', multiSelect: false })
    await replies([ok({ choice: '예', confidence: 0.8, reason: '승인 규칙' })])

    await sp.enqueueEligible()
    const s = await drain(sp.shadowPredictHandler)
    assert.equal(s.done, 1)

    const args = JSON.parse(await readFile(join(dir, 'calls', '0.json'), 'utf8')) as string[]
    const system = args[args.indexOf('--system-prompt') + 1]!
    const prompt = args.at(-1)!
    assert.match(system, /OLD RULES/) // 09-10 결정이면 09-01 커밋
    assert.doesNotMatch(system, /NEW RULES/)
    assert.doesNotMatch(prompt, /추천/) // 표시가 지워졌다
    // 선택지는 enum 으로 묶인다
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]!)
    assert.deepEqual(schema.properties.choice.enum, ['예', '아니오'])

    const [p] = await db.select().from(shadowPredictions)
    assert.equal(p!.decisionId, id)
    assert.equal(p!.predicted, '예')
    assert.equal(p!.correct, false) // 수아는 아니오
    assert.equal(Number(p!.confidence), 0.8)
  })

  // 교정 되짚기도 그 시점의 브레인을 쓴다. 교정으로 분류된 메시지만 대상이다.
  test('교정만 되짚고, 그 시점의 sense.md 로 원인을 묻는다', async () => {
    await db.execute(sql`truncate ${messages}, ${sessions} cascade`)
    await db.insert(sessions).values({ id: 's1', cwd: '/r', repo: 'r', startedAt: new Date(), lastSeenAt: new Date() })
    await db.insert(messages).values([
      { id: 'a1', sessionId: 's1', ts: new Date('2026-09-10T00:00:00Z'), kind: 'assistant', text: '커밋했어요' },
      { id: 'c1', sessionId: 's1', ts: new Date('2026-09-10T00:01:00Z'), kind: 'typed', text: '왜 물어보지도 않고 커밋해', replyTo: 'a1' },
      { id: 'ok1', sessionId: 's1', ts: new Date('2026-09-10T00:02:00Z'), kind: 'typed', text: '좋아' },
    ])
    const [job] = await db.insert(llmJobs).values({ kind: 'message-intent', subject: 'seed', status: 'done', input: {} }).returning({ id: llmJobs.id })
    await db.insert(messageIntents).values([
      { messageId: 'c1', jobId: job!.id, intent: 'correction', confidence: '0.9' },
      { messageId: 'ok1', jobId: job!.id, intent: 'approval', confidence: '0.9' },
    ])
    await replies([ok({ cause: 'ignored', rule: 'BI-10', inboxDraft: 'x', reason: '승인 규칙을 안 따름' })])

    const cr = await import('./correction-replay.js')
    assert.equal(await cr.enqueueCorrections(), 1)
    const s = await drain(cr.correctionReplayHandler)

    assert.equal(s.done, 1)
    const args = JSON.parse(await readFile(join(dir, 'calls', '0.json'), 'utf8')) as string[]
    assert.match(args[args.indexOf('--system-prompt') + 1]!, /OLD RULES/)
    assert.match(args.at(-1)!, /커밋했어요[\s\S]*왜 물어보지도 않고 커밋해/) // 맥락 다음에 교정
    // rule 은 그 커밋의 규칙 id 로 묶인다. 테스트 브레인의 OLD RULES 에는 BI-10 이 있다.
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]!)
    assert.deepEqual(schema.properties.rule.enum, ['', 'BI-10'])
    const [row] = await db.select().from(correctionReplays)
    assert.deepEqual([row!.messageId, row!.cause, row!.rule], ['c1', 'ignored', 'BI-10'])
  })

  // 평가 결과 적재. 서버 스케줄러와 CLI 가 겹쳐 도는 경우를 흉내 내 둘을 동시에 부른다.
  // 한쪽만 넣고, 다른 쪽은 죽지 않고 0을 돌려줘야 한다.
  test('평가 결과는 동시에 적재해도 한 번만 들어가고 둘 다 성공한다', async () => {
    await mkdir(join(brain, 'evals', 'results'), { recursive: true })
    const run = (baseline: boolean) => ({
      ranAt: '2026-09-10T00:00:00Z', model: 'sonnet', judgeModel: 'haiku', baseline, total: 1, passed: 1,
      results: [{ id: 'case-a', rules: ['BI-10'], pass: true, reason: 'ok' }],
    })
    await writeFile(join(brain, 'evals', 'results', 'r1.json'), JSON.stringify(run(false)))
    await writeFile(join(brain, 'evals', 'results', 'r2.json'), JSON.stringify(run(true)))
    const { ingestEvals } = await import('../ingest/evals.js')

    const [x, y] = await Promise.all([ingestEvals(), ingestEvals()])

    assert.equal(x.evalRuns + y.evalRuns, 2)
    const modes = (await db.select().from(evalRuns)).map((r) => r.mode).sort()
    assert.deepEqual(modes, ['baseline', 'full'])
    assert.equal((await db.select().from(evalResults)).length, 2)
  })

  // eval 초안 → 브레인 레포 파일. 이 describe 안에서만 돈다: BRAIN_DIR 이 임시 레포를 가리키는 곳이다.
  // 밖에서 돌면 진짜 suah-brain/evals/cases 에 파일이 생긴다.
  test('eval 초안: 동시에 두 번 눌러도 파일은 하나, 있는 파일은 안 덮고, 규칙 무시는 그 규칙을 지킨다', async () => {
    await db.execute(sql`truncate ${messages}, ${sessions} cascade`)
    await db.insert(sessions).values({ id: 's1', cwd: '/r', repo: 'r', startedAt: new Date(), lastSeenAt: new Date() })
    await db.insert(messages).values([
      { id: 'c1', sessionId: 's1', ts: new Date('2026-09-10T00:01:00Z'), kind: 'typed', text: '왜 물어보지도 않고 커밋해' },
      { id: 'c2', sessionId: 's1', ts: new Date('2026-09-10T00:02:00Z'), kind: 'typed', text: '화면 확인 안 했잖아' },
    ])
    const [seed] = await db.insert(llmJobs).values({ kind: 'correction-replay', subject: 'seed', status: 'done', input: {} }).returning({ id: llmJobs.id })
    await db.insert(correctionReplays).values([
      { messageId: 'c1', jobId: seed!.id, brainCommit: 'x', cause: 'ignored', rule: 'BI-10', reason: '-' },
      { messageId: 'c2', jobId: seed!.id, brainCommit: 'x', cause: 'ignored', rule: 'BI-10', reason: '-' },
    ])
    await mkdir(join(brain, 'evals', 'cases'), { recursive: true })
    // 같은 slug 두 번 → 두 번째는 -2 가 붙는다. 모델이 규칙을 빼먹어도 규칙 무시면 그 규칙이 채워진다.
    const draft = { slug: 'ask-before-commit-always', title: 'Ask before commit', rules: [], scenario: 'S', expected: 'E', antiPattern: 'A' }
    await replies([ok(draft), ok(draft)])
    const ed = await import('./eval-draft.js')
    await ed.enqueueReplays()
    await drain(ed.evalDraftHandler)
    const drafts = await db.select().from(evalDrafts).orderBy(evalDrafts.messageId)
    assert.deepEqual(drafts.map((d) => d.caseId), ['bi-10-ask-before-commit-always', 'bi-10-ask-before-commit-always-2'])
    assert.deepEqual(drafts[0]!.rules, ['BI-10'])
    assert.match(drafts[0]!.body, /^---\nid: bi-10-ask-before-commit-always\nkind: eval\nstatus: draft\n/)

    const { buildApp } = await import('../app.js')
    const app = await buildApp({ ingest: false })
    try {
      const [x, y] = await Promise.all([
        app.inject({ method: 'POST', url: '/evals/drafts/c1/accept' }),
        app.inject({ method: 'POST', url: '/evals/drafts/c1/accept' }),
      ])
      assert.deepEqual([x.statusCode, y.statusCode].sort(), [200, 409])
      const file = join(brain, 'evals', 'cases', 'bi-10-ask-before-commit-always.md')
      assert.equal(await readFile(file, 'utf8'), drafts[0]!.body)

      // 같은 이름의 파일이 이미 있으면 덮지 않고, 초안은 pending 으로 돌아간다
      await writeFile(join(brain, 'evals', 'cases', 'bi-10-ask-before-commit-always-2.md'), 'MINE')
      const z = await app.inject({ method: 'POST', url: '/evals/drafts/c2/accept' })
      assert.equal(z.statusCode, 409)
      assert.equal(await readFile(join(brain, 'evals', 'cases', 'bi-10-ask-before-commit-always-2.md'), 'utf8'), 'MINE')
      const [c2] = await db.select().from(evalDrafts).where(eq(evalDrafts.messageId, 'c2'))
      assert.equal(c2!.status, 'pending')

      assert.equal((await app.inject({ method: 'POST', url: '/evals/drafts/c2/reject' })).statusCode, 200)
      assert.equal((await app.inject({ method: 'POST', url: '/evals/drafts/c2/accept' })).statusCode, 409) // 이미 결정함
    } finally {
      await app.close()
    }
  })

  test('선택지에 없는 답은 오답이 아니라 실패로 남는다', async () => {
    await decision('커밋할까요?', '2026-09-10T00:00:00Z', { chosen: '예 (추천)', multiSelect: false })
    await replies([ok({ choice: '모르겠다', confidence: 0.5, reason: '-' })])

    await sp.enqueueEligible()
    const s = await drain(sp.shadowPredictHandler)

    assert.equal(s.failed, 1)
    assert.equal((await db.select().from(shadowPredictions)).length, 0)
    const [job] = await db.select().from(llmJobs)
    assert.match(job!.error!, /선택지에 없는 답/)
  })
})

describe('message-intent', () => {
  let mi: typeof import('./message-intent.js')
  before(async () => {
    mi = await import('./message-intent.js')
  })

  // 메시지 25개 = 묶음 2개(20 + 5). 일꾼 여럿이 돌아도 묶음마다 한 번씩만 부른다.
  test('묶어서 분류하고, 동시에 돌려도 묶음마다 한 번씩만 부른다', async () => {
    await db.execute(sql`truncate ${messages}, ${sessions} cascade`)
    await db.insert(sessions).values({ id: 's1', cwd: '/r', repo: 'r', startedAt: new Date(), lastSeenAt: new Date() })
    await db.insert(messages).values({ id: 'a1', sessionId: 's1', ts: new Date('2026-09-01T00:00:00Z'), kind: 'assistant', text: '다 지웠어요' })
    const ids = Array.from({ length: 25 }, (_, i) => `u${String(i).padStart(2, '0')}`)
    for (const [i, id] of ids.entries())
      await db.insert(messages).values({
        id,
        sessionId: 's1',
        ts: new Date(Date.UTC(2026, 8, 1, 0, i + 1)),
        kind: 'typed',
        text: `메시지 ${i}`,
        replyTo: i === 0 ? 'a1' : null,
      })
    const answer = (xs: string[]) => ok({ items: xs.map((id) => ({ id, intent: 'correction', confidence: 0.9 })) })
    await replies([answer(ids.slice(0, 20)), answer(ids.slice(20))])

    assert.equal(await mi.enqueueUnclassified(), 2)
    assert.equal(await mi.enqueueUnclassified(), 0) // 대기 중인 묶음에 든 메시지는 다시 안 묶는다
    const s = await drain(mi.messageIntentHandler)

    assert.equal(s.done, 2)
    assert.equal((await readdir(join(dir, 'calls'))).length, 2)
    assert.equal((await db.select().from(messageIntents)).length, 25)
    // 직전 에이전트 글이 맥락으로 들어갔다(u00 만 replyTo 가 있다)
    assert.equal((await prompts()).filter((p) => p.includes('다 지웠어요')).length, 1)
  })

  // 한 건이라도 빠지면 묶음 전체가 실패한다. 빠뜨린 답은 나머지도 믿기 어려워서다(message-intent.ts apply).
  test('답에서 메시지가 빠지면 묶음 전체가 실패한다', async () => {
    await db.execute(sql`truncate ${messages}, ${sessions} cascade`)
    await db.insert(sessions).values({ id: 's1', cwd: '/r', repo: 'r', startedAt: new Date(), lastSeenAt: new Date() })
    for (const id of ['x1', 'x2'])
      await db.insert(messages).values({ id, sessionId: 's1', ts: new Date(), kind: 'typed', text: id })
    await replies([ok({ items: [{ id: 'x1', intent: 'approval', confidence: 0.9 }] })])

    await mi.enqueueUnclassified()
    const s = await drain(mi.messageIntentHandler)

    assert.equal(s.failed, 1)
    assert.equal((await db.select().from(messageIntents)).length, 0)
  })
})

describe('answer-policy', () => {
  let ap: typeof import('./answer-policy.js')
  before(async () => {
    ap = await import('./answer-policy.js')
  })

  // 종류 하나에 결정 둘. 답 라벨은 다르지만 같은 정책으로 묶인다. 답이 하나뿐인 종류는 안 넣는다.
  async function seed() {
    const [job] = await db.insert(llmJobs).values({ kind: 'question-kind', subject: 'seed', status: 'done', input: {} }).returning({ id: llmJobs.id })
    await db.insert(questionKinds).values([
      { name: '커밋 승인', description: '커밋할지', createdByJob: job!.id },
      { name: '혼자', description: '답 하나', createdByJob: job!.id },
    ])
    const a = await decision('커밋할까요?', '2026-09-01T00:00:00Z', { options: ['커밋하고 push (추천)', '아직'], chosen: '커밋하고 push (추천)' })
    const b = await decision('이거 올릴까요?', '2026-09-02T00:00:00Z', { options: ['feat 하나로 (추천)', '보류'], chosen: 'feat 하나로 (추천)' })
    const c = await decision('혼자인 질문', '2026-09-03T00:00:00Z', { options: ['x', 'y'], chosen: 'x' })
    await db.insert(decisionKinds).values([
      { decisionId: a, kind: '커밋 승인', jobId: job!.id },
      { decisionId: b, kind: '커밋 승인', jobId: job!.id },
      { decisionId: c, kind: '혼자', jobId: job!.id },
    ])
    return { a, b }
  }

  test('종류 하나를 한 번에 묶고, 다시 돌리면 정책을 통째로 갈아 끼운다', async () => {
    const { a, b } = await seed()
    await replies([
      ok({ policies: [{ name: '지금 올림', description: '바로 커밋한다' }], assignments: [{ id: a, policy: '지금 올림' }, { id: b, policy: '지금 올림' }] }),
    ])

    assert.equal(await ap.enqueueKinds(), 1) // '혼자'는 답이 하나라 빠진다
    assert.equal(await ap.enqueueKinds(), 0) // 결정 목록이 그대로면 다시 안 들어간다
    const s = await drain(ap.answerPolicyHandler)
    assert.equal(s.done, 1)
    // 표시는 지워서 보여준다
    const [p] = await prompts()
    assert.match(p!, /Suah chose: 커밋하고 push\n/)
    assert.deepEqual((await db.select().from(decisionPolicies)).map((r) => r.policy), ['지금 올림', '지금 올림'])
  })

  test('배정이 빠지거나 목록에 없는 정책을 가리키면 종류 전체가 실패한다', async () => {
    const { a, b } = await seed()
    await replies([
      ok({ policies: [{ name: '지금 올림', description: '-' }], assignments: [{ id: a, policy: '지금 올림' }, { id: b, policy: '없는 정책' }] }),
    ])

    await ap.enqueueKinds()
    const s = await drain(ap.answerPolicyHandler)

    assert.equal(s.failed, 1)
    assert.equal((await db.select().from(answerPolicies)).length, 0)
    assert.equal((await db.select().from(decisionPolicies)).length, 0)
  })
})

describe('draft-theme', () => {
  async function seed() {
    await db.execute(sql`truncate ${messages}, ${sessions} cascade`)
    await db.insert(sessions).values({ id: 's1', cwd: '/r', repo: 'r', startedAt: new Date(), lastSeenAt: new Date() })
    const [j] = await db.insert(llmJobs).values({ kind: 'seed', subject: 's', status: 'done', input: {} }).returning({ id: llmJobs.id })
    for (const id of ['m1', 'm2', 'm3']) {
      await db.insert(messages).values({ id, sessionId: 's1', ts: new Date(), kind: 'typed', text: id })
      await db.insert(correctionReplays).values({ messageId: id, jobId: j!.id, brainCommit: 'x', cause: 'missing', reason: '-' })
      await db.insert(evalDrafts).values({ messageId: id, jobId: j!.id, caseId: `new-${id}`, title: id, rules: [], body: `## Anti-pattern\n\nmistake ${id}` })
    }
  }

  test('규칙 없음 초안 전체를 한 번에 묶고, 대표가 자기 주제에 없으면 실패한다', async () => {
    const dt = await import('./draft-theme.js')
    await seed()
    await replies([
      ok({
        themes: [
          { name: '말투', description: '-', representative: 'new-m1' },
          { name: '확인', description: '-', representative: 'new-m1' }, // 대표가 '말투' 주제에 배정된 초안
        ],
        assignments: [
          { caseId: 'new-m1', theme: '말투' },
          { caseId: 'new-m2', theme: '말투' },
          { caseId: 'new-m3', theme: '확인' },
        ],
      }),
      ok({
        themes: [
          { name: '말투', description: '-', representative: 'new-m1' },
          { name: '확인', description: '-', representative: 'new-m3' },
        ],
        assignments: [
          { caseId: 'new-m1', theme: '말투' },
          { caseId: 'new-m2', theme: '말투' },
          { caseId: 'new-m3', theme: '확인' },
        ],
      }),
    ])

    assert.equal(await dt.enqueueThemes(), 1)
    assert.equal((await drain(dt.draftThemeHandler)).failed, 1)
    assert.equal((await db.select().from(draftThemes)).length, 0)

    await db.update(llmJobs).set({ status: 'queued' }).where(eq(llmJobs.kind, 'draft-theme'))
    assert.equal((await drain(dt.draftThemeHandler)).done, 1)
    // 모델에는 Anti-pattern 절만 갔다
    assert.match((await prompts())[1]!, /Mistake: mistake m1/)
    const rows = await db.select({ caseId: evalDrafts.caseId, theme: evalDrafts.theme }).from(evalDrafts).orderBy(evalDrafts.caseId)
    assert.deepEqual(rows.map((r) => r.theme), ['말투', '말투', '확인'])
  })
})
