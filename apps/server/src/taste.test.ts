import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db, pool } from './db/index.js'
import { agentEdits, commitSurvival, editSurvival, llmJobs, sessions, tasteOwnership } from './db/schema.js'
import { addedLines, measureSurvival } from './taste.js'
import { measureCommits } from './taste-blame.js'

// 남은 비율 측정. 진짜 레포 대신 임시 git 레포를 만든다. 기준 브랜치(main)의 파일에는 에이전트가 쓴 줄
// 가운데 일부만 남겨 두고, 몇 줄이 남았다고 세는지 본다.

let repo: string

before(async () => {
  const rows = (await db.execute<{ name: string }>(sql`select current_database() as name`)).rows
  assert.match(rows[0]?.name ?? '', /_test$/, '테스트 DB 가 아닙니다.')
  repo = await mkdtemp(join(tmpdir(), 'agent-console-taste-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  // 기준 브랜치의 최종 상태: 에이전트가 쓴 세 줄 중 두 줄이 남았고, 한 줄은 수아가 바꿨다.
  await writeFile(join(repo, 'a.ts'), 'const kept = 1\nconst alsoKept = 2\nconst changedBySuah = 99\n')
  await writeFile(join(repo, '.gitignore'), 'scratch/\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'final'], { cwd: repo })
  await db.execute(sql`truncate ${sessions} cascade`)
  await db.insert(sessions).values({ id: 's1', cwd: repo, repo: 'r', startedAt: new Date(), lastSeenAt: new Date() })
})

after(async () => {
  await rm(repo, { recursive: true, force: true })
  await pool.end()
})

describe('taste', () => {
  test('더한 줄: 원래 있던 문맥 줄과 짧은 줄은 뺀다', () => {
    assert.deepEqual(addedLines('const a = 1\n}', 'const a = 1\nconst b = 2\n}\n'), ['const b = 2'])
    assert.deepEqual(addedLines(null, '  x  \nreturn value\n'), ['return value'])
  })

  test('기준 브랜치에 남은 줄만 센다. 파일이 없거나 레포 밖이면 따로 둔다', async () => {
    await db.insert(agentEdits).values([
      {
        id: 'e1', sessionId: 's1', ts: new Date(), tool: 'Write', filePath: join(repo, 'a.ts'),
        newText: 'const kept = 1\nconst alsoKept = 2\nconst changedBySuah = 3\n',
      },
      { id: 'e2', sessionId: 's1', ts: new Date(), tool: 'Write', filePath: join(repo, 'gone.ts'), newText: 'const x = 1\n' },
      { id: 'e3', sessionId: 's1', ts: new Date(), tool: 'Write', filePath: '/nonexistent/dir/z.ts', newText: 'const y = 1\n' },
      // git 이 무시하는 메모는 재지 않는다
      { id: 'e5', sessionId: 's1', ts: new Date(), tool: 'Write', filePath: join(repo, 'scratch', 'plan.md'), newText: 'plan line one\n' },
      // 실패한 수정은 재지 않는다 — 파일에 들어간 적이 없다
      { id: 'e4', sessionId: 's1', ts: new Date(), tool: 'Write', filePath: join(repo, 'a.ts'), newText: 'const kept = 1\n', failed: true },
    ])

    const r = await measureSurvival()

    assert.equal(r.measured, 2) // e3 는 레포 밖, e4 는 실패, e5 는 git 이 무시
    const rows = Object.fromEntries((await db.select().from(editSurvival)).map((s) => [s.editId, s]))
    assert.deepEqual([rows.e1!.added, rows.e1!.kept, rows.e1!.fileFound, rows.e1!.ref], [3, 2, true, 'main'])
    assert.deepEqual([rows.e2!.fileFound, rows.e2!.kept], [false, 0])
  })
  // 커밋 기준. 수아 명의 + Claude 표시 커밋이 세 줄을 쓰고, 수아가 손으로 한 줄을 바꾸고, 남이 한 줄을 더한다.
  test('커밋 기준: 내용으로 남은 줄을 세고, 줄 주인은 에이전트/수아 손/남으로 나눈다', async () => {
    const r2 = await mkdtemp(join(tmpdir(), 'agent-console-taste2-'))
    const g = (...a: string[]) => execFileSync('git', a, { cwd: r2 })
    // 파일을 쓰고 그 사람 명의로 커밋한다
    const step = async (content: string, email: string, msg: string) => {
      await writeFile(join(r2, 'f.ts'), content)
      g('add', '-A')
      g('-c', `user.email=${email}`, '-c', 'user.name=n', 'commit', '-qm', msg)
    }
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'me@x') // 이 레포의 "수아" 명의
    await step('const one = 1\nconst two = 2\nconst three = 3\n', 'me@x', 'feat: agent\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')
    await step('const one = 1\nconst two = 2\nconst three = 33\n', 'me@x', 'fix: by hand')
    await step('const one = 1\nconst two = 2\nconst three = 33\nconst four = 4\n', 'other@x', 'feat: someone else')
    await db.execute(sql`truncate ${sessions} cascade`)
    await db.insert(sessions).values({ id: 's2', cwd: r2, repo: 'r2', startedAt: new Date(), lastSeenAt: new Date() })

    const r = await measureCommits()

    assert.equal(r.commits, 1) // 에이전트 커밋은 하나. 손 커밋과 남의 커밋은 대상이 아니다
    const [c] = await db.select().from(commitSurvival)
    assert.deepEqual([c!.added, c!.kept], [3, 2]) // "three = 3" 은 수아가 손으로 바꿨다
    const [o] = await db.select().from(tasteOwnership)
    assert.deepEqual([o!.agentLines, o!.mineLines, o!.otherLines], [2, 1, 1])
    await rm(r2, { recursive: true, force: true })
  })
  // 다시 쓰인 커밋 재료 모으기. 에이전트 줄을 실제로 지운 커밋만, 바꾼 사람 표시와 함께 넣는다.
  test('taste-diff: 에이전트 줄을 지운 뒤 커밋만 모으고 바꾼 사람을 git 명의로 정한다', async () => {
    const r3 = await mkdtemp(join(tmpdir(), 'agent-console-taste3-'))
    const g = (...a: string[]) => execFileSync('git', a, { cwd: r3 }).toString()
    const step = async (file: string, content: string, email: string, msg: string) => {
      await writeFile(join(r3, file), content)
      g('add', '-A')
      g('-c', `user.email=${email}`, '-c', 'user.name=n', 'commit', '-qm', msg)
    }
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'me@x')
    const agentBody = Array.from({ length: 25 }, (_, i) => `const agentLine${i} = ${i}`).join('\n') + '\n'
    await step('f.ts', agentBody, 'me@x', 'feat: agent\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')
    await step('other.ts', 'const unrelated = 1\n', 'other@x', 'chore: 다른 파일') // f.ts 를 안 건드린 커밋
    await step('f.ts', 'const renamedByHand = 1\n', 'me@x', 'refactor: 손으로 다시 씀') // 에이전트 줄을 지운 커밋
    const sha = g('rev-list', '--max-parents=0', 'HEAD').trim()
    await db.execute(sql`truncate ${sessions} cascade`)
    await db.insert(sessions).values({ id: 's3', cwd: r3, repo: 'r3', startedAt: new Date(), lastSeenAt: new Date() })
    const repo = r3.split('/').pop()!
    await db.insert(commitSurvival).values({ repo, sha, committedAt: new Date(), subject: 'feat: agent', added: 25, kept: 0, ref: 'main', checkedAt: new Date() })

    // 다른 테스트 파일이 남긴 작업에 기대지 않는다. 같은 대상의 작업이 있으면 enqueue 가 건너뛴다.
    await db.delete(llmJobs).where(sql`${llmJobs.kind} = 'taste-diff'`)
    const td = await import('./jobs/taste-diff.js')
    assert.equal(await td.enqueueRewritten(), 1)
    const [job] = await db.select().from(llmJobs).where(sql`${llmJobs.kind} = 'taste-diff'`)
    const input = job!.input as { files: Array<{ path: string; later: Array<{ who: string; subject: string }> }> }
    assert.deepEqual(input.files.map((f) => f.path), ['f.ts'])
    assert.deepEqual(input.files[0]!.later.map((c) => [c.who, c.subject]), [['suah-hand', 'refactor: 손으로 다시 씀']])
    await rm(r3, { recursive: true, force: true })
  })
})
