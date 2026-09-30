import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, eq } from 'drizzle-orm'
import { db, pool } from '../db/index.js'
import { sessions, turns, skillInvocations, toolResults, messages } from '../db/schema.js'
import { emptyTranscriptStats, ingestFile } from './transcripts.js'

// DB 를 실제로 건드리는 유일한 테스트 파일이다. parseFile 쪽 테스트는 메모리까지만 가고
// 여기서부터가 트랜잭션·충돌 처리·멱등성이 사는 층이다.
//
// 격리는 별도 DB(agent_console_test)로 한다. 테스트마다 트랜잭션을 열고 롤백하는 방식도
// 있지만 그러려면 ingestFile 이 트랜잭션을 주입받도록 프로덕션 코드를 바꿔야 한다.
// 이 저장소는 메커니즘이 보이는 게 목적이라 테스트 편의로 층을 하나 끼우는 건 방향이 반대고,
// 무엇보다 진짜 트랜잭션이 그대로 돌아야 롤백을 검증할 수 있다.
//
// 실행은 pnpm test 하나다. 스크립트가 DATABASE_URL 을 항상 테스트 DB 로 고정해서
// "환경변수 깜빡함" 경로 자체를 없앴다. 그래도 아래 before 훅이 한 번 더 막는다 —
// 스크립트를 우회해 직접 돌리는 경우가 남기 때문이다.

let dir: string
let n = 0

async function fixture(lines: unknown[]) {
  const path = join(dir, `f${n++}.jsonl`)
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return path
}

const base = { sessionId: 's1', timestamp: '2026-09-29T00:00:00.000Z', cwd: '/repo/demo' }

function assistantLine(usage: Record<string, number>, over: Record<string, unknown> = {}) {
  return {
    ...base,
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5', usage },
    ...over,
  }
}

const run = (path: string) => ingestFile(path, emptyTranscriptStats())

describe('ingestFile (DB)', () => {
  before(async () => {
    // 안전장치. 이게 없으면 DATABASE_URL 을 안 넘겼을 때 실서비스 DB 를 truncate 한다.
    // 테스트가 데이터를 지우는 쪽이라 실수의 대가가 크고, 되돌릴 수도 없다.
    const rows = (await db.execute<{ name: string }>(sql`select current_database() as name`)).rows
    // 빈 결과면 DB 이름을 모른다는 뜻이고, 모르면 통과시키지 않는다.
    const name = rows[0]?.name ?? '(알 수 없음)'
    assert.match(
      name,
      /_test$/,
      `테스트 DB 가 아닙니다(${name}). DATABASE_URL 을 *_test 로 지정하고 실행하세요.`,
    )
    dir = await mkdtemp(join(tmpdir(), 'agent-console-db-'))
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${sessions}, ${turns}, ${skillInvocations}, ${toolResults}, ${messages} restart identity cascade`,
    )
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
    // pool 을 안 닫으면 테스트 프로세스가 안 끝난다.
    await pool.end()
  })

  test('파일 하나가 세션·턴·스킬·도구응답으로 들어간다', async () => {
    const path = await fixture([
      assistantLine(
        { input_tokens: 10, output_tokens: 20 },
        {
          message: {
            id: 'msg_1',
            model: 'claude-opus-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'suah-judge', args: '' } },
              { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
            ],
          },
        },
      ),
      {
        ...base,
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'hello world' }],
        },
      },
    ])

    const r = await run(path)

    assert.equal(r.turns, 1)
    assert.equal(r.skills, 1)
    assert.equal((await db.select().from(sessions)).length, 1)
    assert.equal((await db.select().from(turns)).length, 1)
    const tools = await db.select().from(toolResults)
    assert.equal(tools.length, 1)
    assert.equal(tools[0]!.tool, 'Read') // 이름은 tool_use 에서 왔다
    assert.ok(tools[0]!.bytes > 0)
  })

  // 같은 파일을 몇 번이고 다시 읽는 것이 이 적재의 전제다. 두 번째 실행이 0이어야 한다.
  test('두 번 돌려도 행이 안 늘어난다', async () => {
    const path = await fixture([assistantLine({ input_tokens: 10, output_tokens: 20 })])

    const first = await run(path)
    const second = await run(path)

    assert.equal(first.turns, 1)
    assert.equal(second.turns, 0)
    assert.equal(second.turnsUpdated, 0)
    assert.equal((await db.select().from(turns)).length, 1)
    assert.equal((await db.select().from(sessions)).length, 1)
  })

  // 스트리밍 중간 상태가 먼저 저장된 뒤 완성본이 오는 경우. 토큰은 자란다.
  test('토큰이 더 큰 값으로 오면 갱신된다', async () => {
    await run(await fixture([assistantLine({ input_tokens: 2, output_tokens: 1 })]))
    const r = await run(await fixture([assistantLine({ input_tokens: 2, output_tokens: 145 })]))

    assert.equal(r.turns, 0) // 새 행은 없고
    assert.equal(r.turnsUpdated, 1) // 고친 행이 하나
    const [row] = await db.select().from(turns)
    assert.equal(row!.outputTokens, 145)
  })

  // greatest(). 파일이 잘려 다시 읽히면 이번 값이 더 작을 수 있는데, 그때 내려가면 안 된다.
  test('작은 값이 나중에 와도 내려가지 않는다', async () => {
    await run(await fixture([assistantLine({ input_tokens: 2, output_tokens: 145 })]))
    const r = await run(await fixture([assistantLine({ input_tokens: 2, output_tokens: 1 })]))

    assert.equal(r.turnsUpdated, 0) // setWhere 가 걸러서 갱신 자체가 안 일어난다
    const [row] = await db.select().from(turns)
    assert.equal(row!.outputTokens, 145)
  })

  // 파일 하나 = 트랜잭션 하나. 세션은 턴보다 먼저 들어가므로, 턴에서 실패하면
  // 세션만 남은 반쪽 상태가 될 수 있다. 그게 안 된다는 것이 이 테스트다.
  test('턴 삽입이 실패하면 세션도 안 남는다', async () => {
    // int4 범위를 넘는 토큰 값. parseFile 은 숫자를 그대로 통과시키고 Postgres 가 거부한다.
    const path = await fixture([assistantLine({ input_tokens: 9999999999, output_tokens: 1 })])

    // Drizzle 이 Postgres 원문(out of range)을 cause 로 감싸므로 메시지로는 못 맞춘다.
    // 여기서 확인할 것은 "턴 삽입 단계에서 터졌다"이고, 그래야 아래 롤백 검증이 의미를 갖는다.
    await assert.rejects(() => run(path), /insert into "turns"/)

    assert.equal((await db.select().from(sessions)).length, 0)
    assert.equal((await db.select().from(turns)).length, 0)
  })

  test('세션이 없는 파일은 아무것도 안 넣고 filesEmpty 를 올린다', async () => {
    const stats = emptyTranscriptStats()
    const path = await fixture([{ type: 'summary', text: 'no session' }])

    const r = await ingestFile(path, stats)

    assert.equal(r.turns, 0)
    assert.equal(stats.filesEmpty, 1)
    assert.equal((await db.select().from(sessions)).length, 0)
  })

  // 재개된 세션은 파일이 나뉘어도 같은 세션 id 를 쓴다. last_seen_at 은 늘어나야 한다.
  test('같은 세션을 다시 읽으면 last_seen_at 이 갱신된다', async () => {
    await run(await fixture([assistantLine({ input_tokens: 1, output_tokens: 1 })]))
    await run(
      await fixture([
        {
          ...base,
          timestamp: '2026-09-30T12:00:00.000Z',
          type: 'assistant',
          message: { id: 'msg_2', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ]),
    )

    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    assert.equal(row!.lastSeenAt.toISOString(), '2026-09-30T12:00:00.000Z')
  })

  // 적재가 진행 중인 세션을 읽으면 응답의 뒷 블록이 아직 없을 수 있다.
  // 다음 실행에서 더 긴 글이 오면 채워지고, 같은 글이면 아무것도 안 바뀐다.
  test('에이전트 글은 길어질 때만 갱신되고 다시 읽어도 안 늘어난다', async () => {
    const line = (content: unknown[]) =>
      assistantLine({ input_tokens: 1, output_tokens: 1 }, {
        message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content },
      })
    const text = (t: string) => ({ type: 'text', text: t })

    const first = await run(await fixture([line([text('앞')])]))
    const again = await run(await fixture([line([text('앞')])]))
    await run(await fixture([line([text('앞')]), line([text('뒤')])]))
    // 잘린 파일을 다시 읽어 짧은 글이 와도 내려가지 않는다
    await run(await fixture([line([text('앞')])]))

    assert.equal(first.messages, 1)
    assert.equal(again.messages, 0)
    const [row] = await db.select().from(messages)
    assert.equal(row!.text, '앞\n뒤')
  })

  // 도구가 걸린 시간 = 응답 줄 시각 - 호출 줄 시각. 열이 생기기 전에 들어간 행은 비어 있다가
  // 다음 적재에서 한 번 채워진다.
  test('도구 호출 시각이 남고, 비어 있던 행은 한 번만 채워진다', async () => {
    const lines = [
      assistantLine(
        { input_tokens: 1, output_tokens: 1 },
        {
          timestamp: '2026-09-29T00:00:00.000Z',
          message: {
            id: 'msg_1',
            model: 'claude-opus-5',
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: {} }],
          },
        },
      ),
      {
        ...base,
        timestamp: '2026-09-29T00:03:00.000Z',
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'a' }] },
      },
    ]
    const path = await fixture(lines)
    await run(path)
    // 열이 생기기 전 상태를 흉내 낸다
    await db.update(toolResults).set({ calledAt: null })

    await run(path)
    const [row] = await db.select().from(toolResults)
    assert.equal(row!.calledAt!.toISOString(), '2026-09-29T00:00:00.000Z')
    assert.equal(row!.ts.getTime() - row!.calledAt!.getTime(), 3 * 60 * 1000) // 답하기까지 3분

    // 이미 채워진 행은 다시 안 건드린다. updated 가 없는지는 xmax 로 본다.
    const before = (await db.execute<{ x: string }>(sql`select xmin::text as x from tool_results`)).rows[0]!.x
    await run(path)
    const after = (await db.execute<{ x: string }>(sql`select xmin::text as x from tool_results`)).rows[0]!.x
    assert.equal(after, before) // xmin 이 같다 = 행이 다시 쓰이지 않았다
  })
})
