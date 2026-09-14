import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLines } from './lines.js'

// 픽스처를 레포에 파일로 두지 않고 테스트가 직접 쓴다.
// U+2028 은 화면에 안 보이는 글자다. 파일에 리터럴로 박아두면 에디터나 포매터가
// 조용히 지워도 아무도 모르고, 그러면 테스트가 아무것도 검사하지 않으면서 통과한다.
// 그래서 문자열 안에서는 \u2028 이스케이프로만 쓴다 — 눈에 보이고, 포매터가 못 건드린다.
let dir: string

async function fixture(name: string, content: string) {
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

async function collect(path: string) {
  const out: string[] = []
  for await (const line of readLines(path)) out.push(line)
  return out
}

describe('readLines', () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-console-lines-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('\\n 으로 자른다', async () => {
    const p = await fixture('basic.jsonl', '{"a":1}\n{"a":2}\n')
    assert.deepEqual(await collect(p), ['{"a":1}', '{"a":2}'])
  })

  // 이 저장소가 이 함수를 직접 쓰는 이유. node:readline 은 여기서 두 줄로 쪼갠다.
  test('U+2028 은 줄 끝이 아니다', async () => {
    const line = '{"text":"before\u2028after"}'
    const p = await fixture('sep.jsonl', line + '\n')

    assert.deepEqual(await collect(p), [line])
    // 쪼개지지 않았다는 걸 파싱까지 해서 확인한다. 조각이었다면 여기서 던진다.
    assert.equal(JSON.parse(line).text, 'before\u2028after')
  })

  test('U+2029 와 \\r 도 줄 끝이 아니다', async () => {
    // \r 은 JSON 문법에서 공백이라 값 사이에 리터럴로 들어와도 유효하다.
    const line = '{"a":\r1,"b":"x\u2029y"}'
    const p = await fixture('sep2.jsonl', line + '\n')

    assert.deepEqual(await collect(p), [line])
    assert.equal(JSON.parse(line).b, 'x\u2029y')
  })

  test('마지막 줄에 \\n 이 없어도 흘린다', async () => {
    // ingestion 이 도는 동안에도 Claude Code 가 파일에 쓰고 있다. 꼬리가 잘린 상태로 읽힌다.
    const p = await fixture('tail.jsonl', '{"a":1}\n{"a":2}')
    assert.deepEqual(await collect(p), ['{"a":1}', '{"a":2}'])
  })

  test('빈 꼬리는 줄로 세지 않는다', async () => {
    const p = await fixture('trailing.jsonl', '{"a":1}\n')
    assert.deepEqual(await collect(p), ['{"a":1}'])
  })

  test('빈 파일은 아무것도 안 내놓는다', async () => {
    const p = await fixture('empty.jsonl', '')
    assert.deepEqual(await collect(p), [])
  })

  // 스트림은 기본 64KB 씩 읽는다. 여러 바이트짜리 글자가 그 경계에 걸리면
  // 디코딩이 깨질 수 있는 자리다(createReadStream 에 encoding 을 안 주면 실제로 깨진다).
  // 한글로 경계를 확실히 넘겨서 확인한다.
  test('청크 경계에 걸친 한글이 안 깨진다', async () => {
    const big = '가'.repeat(50_000) // UTF-8 로 150KB, 64KB 청크를 두 번 넘는다
    const line = JSON.stringify({ text: big })
    const p = await fixture('big.jsonl', line + '\n{"a":1}\n')

    const lines = await collect(p)
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]!).text, big)
  })
})
