import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { db, pool } from './db/index.js'
import {
  answerPolicies,
  decisionPolicies,
  drillPairs,
  decisions,
  questionKinds,
  llmJobs,
  messageIntents,
  messages,
  sessions,
  shadowPredictions,
  skillInvocations,
  soloDecisions,
} from './db/schema.js'
import { buildApp } from './app.js'
import { elo } from './drill.js'

// 점수판 라우트는 SQL 집계(grouping sets, distinct on, lateral)가 본체다. 눈으로 본 숫자가
// 맞아 보여도 경계(전체 줄과 날짜 줄이 섞이는 자리, 확신 1.0 이 들어갈 칸)는 따로 확인해야 한다.
// app.inject 는 서버를 띄우지 않고 요청 하나를 흘려보낸다 — app.ts 가 build 와 listen 을 나눈 이유.

type App = Awaited<ReturnType<typeof buildApp>>
let app: App
let jobId: number

before(async () => {
  const rows = (await db.execute<{ name: string }>(sql`select current_database() as name`)).rows
  assert.match(rows[0]?.name ?? '', /_test$/, '테스트 DB 가 아닙니다.')
  app = await buildApp({ ingest: false })
})

beforeEach(async () => {
  await db.execute(sql`truncate ${sessions}, ${llmJobs}, ${decisions}, ${skillInvocations} restart identity cascade`)
  await db.insert(sessions).values({ id: 's1', cwd: '/r', repo: 'r', startedAt: new Date(), lastSeenAt: new Date() })
  const [j] = await db.insert(llmJobs).values({ kind: 'seed', subject: 'x', status: 'done', input: {} }).returning({ id: llmJobs.id })
  jobId = j!.id
})

after(async () => {
  await app.close()
  await pool.end()
})

// 최근 날짜 기준. 점수판은 최근 30일만 본다.
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000)

async function typed(id: string, ts: Date, intent?: string) {
  await db.insert(messages).values({ id, sessionId: 's1', ts, kind: 'typed', text: id })
  if (intent) await db.insert(messageIntents).values({ messageId: id, jobId, intent: intent as 'correction', confidence: '0.9' })
}

describe('scoreboard', () => {
  test('개입: 활동 시간은 메시지를 친 시만 세고, 전체 줄과 날짜 줄이 섞이지 않는다', async () => {
    const base = hoursAgo(48)
    base.setMinutes(0, 0, 0)
    const at = (h: number, m: number) => new Date(base.getTime() + h * 3600e3 + m * 60e3)
    await typed('m1', at(0, 5), 'correction')
    await typed('m2', at(0, 40), 'approval') // 같은 시 → 활동 1시간
    await typed('m3', at(2, 10), 'correction') // 다른 시 → 활동 2시간
    await typed('m4', at(2, 20)) // 분류 전

    const r = (await app.inject({ method: 'GET', url: '/scoreboard/interventions' })).json()

    assert.equal(r.typed, 4)
    assert.equal(r.classified, 3)
    assert.equal(r.total.counts.correction, 2)
    assert.equal(r.total.counts.approval, 1)
    // 같은 날에 모두 들어갔다면 날짜 줄도 같은 값이어야 한다(자정을 넘기는 경우는 날짜가 둘)
    const sum = r.byDay.reduce((a: number, d: { counts: { correction: number } }) => a + d.counts.correction, 0)
    assert.equal(sum, 2)
    assert.equal(r.total.activeHours, 2)
  })

  test('보정: 확신 1.0 은 마지막 칸, 0.2 는 둘째 칸에 들어간다', async () => {
    const mk = async (conf: string, correct: boolean) => {
      const [d] = await db
        .insert(decisions)
        .values({ sessionId: 's1', ts: new Date(), header: '', question: conf, options: ['a', 'b'], chosen: 'a', multiSelect: false })
        .returning({ id: decisions.id })
      await db.insert(shadowPredictions).values({
        decisionId: d!.id, jobId, brainCommit: 'c', predicted: correct ? 'a' : 'b', confidence: conf, correct, reason: '-',
      })
    }
    await mk('1.000', true)
    await mk('0.200', false)

    const r = (await app.inject({ method: 'GET', url: '/scoreboard/shadow' })).json()

    assert.equal(r.n, 2)
    assert.equal(r.correct, 1)
    assert.deepEqual(r.calibration.map((b: { n: number }) => b.n), [0, 1, 0, 0, 1])
    assert.equal(r.misses.length, 1)
  })

  test('단계: 메시지 직전의 마지막 스킬이 단계가 된다', async () => {
    await db.insert(skillInvocations).values([
      { id: 'k1', sessionId: 's1', ts: hoursAgo(10), skill: 'feature-plan' },
      { id: 'k2', sessionId: 's1', ts: hoursAgo(5), skill: 'code-review' },
    ])
    await typed('m0', hoursAgo(12), 'new-request') // 스킬 전 → (none)
    await typed('m1', hoursAgo(8), 'correction') // feature-plan 뒤
    await typed('m2', hoursAgo(4), 'approval') // code-review 뒤

    const r = (await app.inject({ method: 'GET', url: '/scoreboard/phases' })).json()
    const by = Object.fromEntries(r.phases.map((p: { phase: string; correction: number; messages: number }) => [p.phase, [p.messages, p.correction]]))

    assert.deepEqual(by, { '(none)': [1, 0], 'feature-plan': [1, 1], 'code-review': [1, 0] })
  })
  test('드리프트: 앞 절반과 뒤 절반의 정책이 다르면 바뀐 걸로 본다', async () => {
    await db.insert(questionKinds).values({ name: '커밋', description: '-', createdByJob: jobId })
    await db.insert(answerPolicies).values([
      { kind: '커밋', name: '지금 올림', description: '-', jobId },
      { kind: '커밋', name: '보류', description: '-', jobId },
    ])
    const seq = ['지금 올림', '지금 올림', '보류', '보류']
    for (const [i, policy] of seq.entries()) {
      const [d] = await db
        .insert(decisions)
        .values({ sessionId: 's1', ts: hoursAgo(10 - i), header: '', question: `q${i}`, options: ['a'], chosen: 'a' })
        .returning({ id: decisions.id })
      await db.insert(decisionPolicies).values({ decisionId: d!.id, kind: '커밋', policy, jobId })
    }

    const r = (await app.inject({ method: 'GET', url: '/scoreboard/drift' })).json()

    assert.equal(r.kinds.length, 1)
    assert.deepEqual([r.kinds[0].early, r.kinds[0].late, r.kinds[0].drifted], ['지금 올림', '보류', true])
  })
  test('감사: 답하지 않은 결정만 오늘의 목록에 오고, 판정은 한 번만 쓴다', async () => {
    await db.insert(messages).values({ id: 'a1', sessionId: 's1', ts: hoursAgo(3), kind: 'assistant', text: '격리는 별도 DB 로 했어요' })
    await db.insert(soloDecisions).values([
      { messageId: 'a1', idx: 0, summary: '별도 DB 로 격리했다', alternative: '롤백', jobId },
      { messageId: 'a1', idx: 1, summary: '파일을 하나씩 돌렸다', alternative: '동시 실행', jobId },
    ])
    const [first] = await db.select().from(soloDecisions).orderBy(soloDecisions.idx)

    const agree = await app.inject({ method: 'POST', url: `/audit/solo/${first!.id}/agree` })
    const again = await app.inject({ method: 'POST', url: `/audit/solo/${first!.id}/disagree` })
    const r = (await app.inject({ method: 'GET', url: '/audit/solo' })).json()

    assert.deepEqual([agree.json().ok, again.json().ok], [true, false]) // 두 번째 판정은 무시된다
    assert.deepEqual([r.extracted, r.answered, r.agree], [2, 1, 1])
    assert.deepEqual(r.today.map((d: { summary: string }) => d.summary), ['파일을 하나씩 돌렸다'])
  })
  // Elo 는 순수 함수라 DB 없이 본다. 이긴 쪽이 오르고 진 쪽이 같은 만큼 내린다(합이 그대로). 비슷함은 동점끼리면 그대로.
  test('Elo: 이기면 오르고, 비슷함은 동점끼리 그대로, 점수 합은 보존된다', () => {
    const one = elo([{ dimension: 'length', styleA: 'terse', styleB: 'detailed', choice: 'a' }])
    const get = (rs: ReturnType<typeof elo>, s: string) => rs.find((r) => r.dimension === 'length' && r.style === s)!
    assert.deepEqual([get(one, 'terse').rating, get(one, 'detailed').rating, get(one, 'balanced').rating], [1516, 1484, 1500])
    const tie = elo([{ dimension: 'order', styleA: 'conclusion-first', styleB: 'context-first', choice: 'tie' }])
    assert.ok(tie.filter((r) => r.dimension === 'order').every((r) => r.rating === 1500 && r.games === 1))
  })

  test('드릴: 고르기는 한 번만, 고른 쌍은 오늘의 목록에서 빠진다', async () => {
    await db.insert(messages).values({ id: 'src1', sessionId: 's1', ts: hoursAgo(1), kind: 'assistant', text: '원문' })
    const [p] = await db
      .insert(drillPairs)
      .values({ dimension: 'length', styleA: 'terse', styleB: 'detailed', sourceMessageId: 'src1', textA: 'A', textB: 'B', jobId })
      .returning({ id: drillPairs.id })

    const first = (await app.inject({ method: 'POST', url: `/drill/${p!.id}/a` })).json()
    const second = (await app.inject({ method: 'POST', url: `/drill/${p!.id}/b` })).json()
    const r = (await app.inject({ method: 'GET', url: '/drill' })).json()

    assert.deepEqual([first.ok, second.ok], [true, false])
    assert.deepEqual([r.decided, r.pending, r.today.length], [1, 0, 0])
    assert.equal(r.ratings.find((x: { style: string }) => x.style === 'terse').rating, 1516)
  })
})
