import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db, pool } from './db/index.js'
import { agentEdits, editSurvival, sessions } from './db/schema.js'
import { addedLines, measureSurvival } from './taste.js'

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
})
