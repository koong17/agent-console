import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTranscriptStats, parseFile } from './transcripts.js'

// parseFile 을 진입점으로 삼는 이유: 파일을 읽어 넣을 행을 메모리에 모으는 데까지가
// 여기고, DB 는 그 다음 층인 ingestFile 이 만진다. 그래서 Postgres 없이 돌 수 있고,
// 카운터 로직도 전부 이 층에 있다.

let dir: string
let n = 0

// 픽스처는 테스트가 직접 쓴다. 줄 배열을 받아 JSONL 파일로 만든다.
async function fixture(lines: unknown[]) {
  const path = join(dir, `f${n++}.jsonl`)
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return path
}

// 모든 줄이 공통으로 갖는 필드. 이게 없으면 parseFile 이 줄을 세션에 붙이지 못한다.
const base = { sessionId: 's1', timestamp: '2026-09-10T00:00:00.000Z', cwd: '/repo/demo' }

// assistant 줄 한 개. turn 하나로 이어진다.
function assistantLine(over: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) {
  return {
    ...base,
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: 20 },
      ...msg,
    },
    ...over,
  }
}

async function parse(lines: unknown[]) {
  const stats = emptyTranscriptStats()
  const parsed = await parseFile(await fixture(lines), stats)
  return { parsed, stats }
}

describe('parseFile', () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-console-transcripts-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('assistant 줄 하나가 turn 하나가 된다', async () => {
    const { parsed, stats } = await parse([assistantLine()])

    assert.equal(parsed?.turns.length, 1)
    assert.equal(parsed?.turns[0]!.model, 'claude-opus-5')
    assert.equal(parsed?.turns[0]!.inputTokens, 10)
    assert.equal(parsed?.session.repo, 'demo') // cwd 의 마지막 조각
    assert.equal(stats.assistantLines, 1)
    assert.equal(stats.unusable, 0)
  })

  // Claude Code 는 같은 응답을 여러 줄에 걸쳐 쓴다(도구 호출 블록마다 한 줄).
  // 토큰을 중복으로 세지 않으려면 message.id 로 접어야 한다.
  test('같은 message.id 가 여러 줄에 나와도 turn 은 하나', async () => {
    const { parsed, stats } = await parse([assistantLine(), assistantLine(), assistantLine()])

    assert.equal(parsed?.turns.length, 1)
    // 접는 건 turn 쪽이고, 카운터는 읽은 줄을 그대로 센다. 둘은 다른 숫자다.
    assert.equal(stats.assistantLines, 3)
  })

  // 2026-09-10 실제 버그. Claude Code 는 스트리밍 중간 상태를 먼저 쓰고 완성본을 나중에 쓴다.
  // 첫 줄을 채택하면 output_tokens 가 미완성 값으로 굳는다 — 전체의 22.75%가 그렇게 빠져 있었다.
  test('같은 id 의 토큰이 다르면 항목별 max 를 취한다', async () => {
    const { parsed } = await parse([
      assistantLine({}, { usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 100 } }),
      assistantLine({}, { usage: { input_tokens: 2, output_tokens: 145, cache_read_input_tokens: 100 } }),
    ])

    assert.equal(parsed?.turns.length, 1)
    assert.equal(parsed?.turns[0]!.outputTokens, 145)
    assert.equal(parsed?.turns[0]!.cacheReadTokens, 100)
  })

  // max 는 순서 가정을 하지 않는다. 큰 값이 먼저 와도 결과가 같아야 한다.
  test('큰 값이 먼저 와도 max 결과는 같다', async () => {
    const { parsed } = await parse([
      assistantLine({}, { usage: { input_tokens: 2, output_tokens: 145 } }),
      assistantLine({}, { usage: { input_tokens: 2, output_tokens: 1 } }),
    ])

    assert.equal(parsed?.turns[0]!.outputTokens, 145)
  })

  // 토큰만 합친다. ts 를 마지막 줄로 옮기면 일별 비용 집계의 날짜 경계가 조용히 움직인다.
  test('토큰이 아닌 열은 첫 줄 값을 유지한다', async () => {
    const { parsed } = await parse([
      assistantLine({ timestamp: '2026-09-10T01:00:00.000Z' }),
      assistantLine({ timestamp: '2026-09-10T23:00:00.000Z' }, { model: 'claude-haiku-4-5-20251001' }),
    ])

    assert.equal(parsed?.turns[0]!.ts.toISOString(), '2026-09-10T01:00:00.000Z')
    assert.equal(parsed?.turns[0]!.model, 'claude-opus-5')
  })

  test('usage 없는 assistant 줄은 unusable 로 잡힌다', async () => {
    const line = assistantLine()
    delete (line.message as Record<string, unknown>).usage
    const { parsed, stats } = await parse([line])

    assert.equal(parsed?.turns.length, 0)
    assert.equal(stats.assistantLines, 1)
    assert.equal(stats.unusable, 1)
    assert.equal(stats.synthetic, 0)
  })

  // '<synthetic>' 은 API 에러 등을 Claude Code 가 만들어 넣은 가짜 응답이다.
  // 예상된 탈락이라 unusable 과 섞이면 "0이면 정상"이라는 기준이 깨진다.
  test("model '<synthetic>' 은 synthetic 으로 빠지고 unusable 엔 안 잡힌다", async () => {
    const { parsed, stats } = await parse([assistantLine({}, { model: '<synthetic>' })])

    assert.equal(parsed?.turns.length, 0)
    assert.equal(stats.synthetic, 1)
    assert.equal(stats.unusable, 0)
  })

  test('아는 type 은 unknownTypeLines 를 올리지 않는다', async () => {
    const { stats } = await parse([
      assistantLine(),
      { ...base, type: 'attachment' },
      { ...base, type: 'mode' },
    ])

    assert.equal(stats.unknownTypeLines, 0)
    assert.deepEqual(stats.typeCounts, { assistant: 1, attachment: 1, mode: 1 })
  })

  // 상류가 type 이름을 바꾸는 경우. 이걸 못 세면 화면이 "조용한 시간"과 구분되지 않는다.
  test('모르는 type 은 unknownTypeLines 로 잡힌다', async () => {
    const renamed = { ...assistantLine(), type: 'response' }
    const { parsed, stats } = await parse([renamed, renamed])

    assert.equal(parsed?.turns.length, 0) // turn 은 하나도 안 나온다
    assert.equal(stats.assistantLines, 0) // 그런데 A형 카운터는 전부 0
    assert.equal(stats.unusable, 0)
    assert.equal(stats.unknownTypeLines, 2) // B형 카운터만 이걸 잡는다
    assert.equal(stats.typeCounts.response, 2)
  })

  test('type 필드가 아예 없으면 <none> 으로 센다', async () => {
    const { stats } = await parse([{ ...base, message: { id: 'x' } }])

    assert.equal(stats.typeCounts['<none>'], 1)
    assert.equal(stats.unknownTypeLines, 1)
  })

  test('깨진 JSON 줄은 badJson 으로 세고 나머지는 계속 읽는다', async () => {
    const path = join(dir, 'broken.jsonl')
    await writeFile(path, '{"broken":\n' + JSON.stringify(assistantLine()) + '\n', 'utf8')
    const stats = emptyTranscriptStats()
    const parsed = await parseFile(path, stats)

    assert.equal(stats.badJson, 1)
    assert.equal(stats.lines, 2)
    assert.equal(parsed?.turns.length, 1) // 한 줄 깨졌다고 파일을 포기하지 않는다
  })

  test('세션 필드가 없는 파일은 null 을 돌려준다', async () => {
    // ingestFile 이 이 null 을 받아 filesEmpty 를 올린다.
    const { parsed, stats } = await parse([{ type: 'summary', text: 'no session here' }])

    assert.equal(parsed, null)
    assert.equal(stats.lines, 1)
  })

  test('사용자가 친 /스킬 은 command 출처로 잡힌다', async () => {
    const { parsed } = await parse([
      {
        ...base,
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: '<command-name>/suah-judge</command-name><command-args>TMS-1234</command-args>',
        },
      },
    ])

    assert.equal(parsed?.skills.length, 1)
    assert.equal(parsed?.skills[0]!.skill, 'suah-judge')
    assert.equal(parsed?.skills[0]!.args, 'TMS-1234')
    assert.equal(parsed?.skills[0]!.source, 'command')
  })

  // /clear, /model 같은 Claude Code 내장 명령은 스킬이 아니다. 섞이면 스킬 사용량이 부풀어 오른다.
  test('내장 슬래시 명령은 스킬로 세지 않는다', async () => {
    const { parsed } = await parse([
      {
        ...base,
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: '<command-name>/clear</command-name>' },
      },
    ])

    assert.equal(parsed?.skills.length, 0)
  })

  test('Skill 도구 호출은 tool 출처로 잡힌다', async () => {
    const { parsed } = await parse([
      assistantLine(
        {},
        {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Skill',
              input: { skill: 'code-review', args: '--fix' },
            },
            { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
          ],
        },
      ),
    ])

    assert.equal(parsed?.skills.length, 1) // Read 는 스킬이 아니다
    assert.equal(parsed?.skills[0]!.skill, 'code-review')
    assert.equal(parsed?.skills[0]!.source, 'tool')
  })

  // 이어서 진행한 세션은 하루를 넘겨 파일 하나에 이어 붙는다.
  // startedAt/lastSeenAt 이 줄 순서가 아니라 실제 최소/최대여야 한다.
  test('세션 시각은 줄 순서와 무관하게 최소/최대를 잡는다', async () => {
    const { parsed } = await parse([
      assistantLine({ timestamp: '2026-09-10T05:00:00.000Z' }),
      assistantLine({
        timestamp: '2026-09-08T01:00:00.000Z',
        message: { id: 'msg_2', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      assistantLine({
        timestamp: '2026-09-12T09:00:00.000Z',
        message: { id: 'msg_3', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ])

    assert.equal(parsed?.session.startedAt.toISOString(), '2026-09-08T01:00:00.000Z')
    assert.equal(parsed?.session.lastSeenAt.toISOString(), '2026-09-12T09:00:00.000Z')
  })
})
