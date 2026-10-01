// 3단계(취향) 첫 숫자: 에이전트가 쓴 줄 가운데 기준 브랜치에 아직 남은 비율.
//
// pnpm taste 가 agent_edits 를 전부 다시 재서 edit_survival 을 갈아 끼운다. LLM 을 안 쓴다 — 로컬 git 만 읽는다.
//
// 한 수정의 "더한 줄": new_text 의 줄 가운데 old_text 에 없던 줄(Edit 이면 원래 있던 문맥 줄은 뺀다).
// 공백을 걷고 4글자 미만인 줄(괄호, 빈 줄)은 뺀다 — 어느 파일에나 있어서 남았다고 세면 부풀려진다.
// "남음": 그 줄(공백 걷은 것)이 기준 브랜치의 같은 파일에 한 번이라도 있다.
//
// 기준 브랜치: 레포마다 origin/develop → origin/main → main → HEAD 순으로 처음 있는 것.
// 작업 트리의 파일을 안 읽는 이유: 지금 체크아웃된 게 다른 기능 브랜치일 수 있다(2026-09-30 appius 가 그랬다).
// fetch 는 하지 않는다. 남의 레포의 원격 상태를 바꾸는 건 아니지만, 측정이 네트워크에 기대지 않게 한다.

import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { agentEdits, editSurvival } from './db/schema.js'

const run = promisify(execFile)
export const git = async (cwd: string, ...args: string[]) =>
  (await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout
const MIN_LINE = 4

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= MIN_LINE)

// 수정 하나가 더한 줄. 같은 줄이 두 번 나오면 두 번 센다 — 두 번 쓴 건 두 번 쓴 것이다.
export function addedLines(oldText: string | null, newText: string) {
  const before = new Set(oldText ? lines(oldText) : [])
  return lines(newText).filter((l) => !before.has(l))
}

// 파일 경로에서 레포 뿌리와 레포 안 상대 경로를 찾는다. 디렉터리가 없으면(지운 worktree, 임시 폴더) null.
//
// 경로를 realpath 로 풀어서 비교한다. git 은 뿌리를 풀린 경로로 주는데(/private/var/...), 기록된 파일 경로는
// 심볼릭 링크를 거친 경로(/var/..., /tmp/...)일 수 있다. 안 풀면 상대 경로가 ../../ 로 새어 파일을 못 찾는다
// (테스트가 잡았다 — macOS 의 임시 폴더가 그렇다).
export async function repoOf(file: string) {
  let dir = dirname(file)
  for (;;) {
    try {
      await access(dir)
      const real = await realpath(dir)
      const root = (await git(real, 'rev-parse', '--show-toplevel')).trim()
      return { root, rel: relative(root, join(real, relative(dir, dirname(file)), basename(file))) }
    } catch {
      const up = dirname(dir)
      if (up === dir) return null
      dir = up
    }
  }
}

export async function baseRef(root: string) {
  for (const ref of ['origin/develop', 'origin/main', 'main', 'HEAD']) {
    try {
      const at = (await git(root, 'log', '-1', '--format=%cI', ref)).trim()
      return { ref, at: new Date(at) }
    } catch {
      /* 다음 후보 */
    }
  }
  return null
}

export async function measureSurvival() {
  const edits = await db
    .select({ id: agentEdits.id, filePath: agentEdits.filePath, oldText: agentEdits.oldText, newText: agentEdits.newText })
    .from(agentEdits)
    .where(sql`${agentEdits.failed} is not true`)
  const roots = new Map<string, { root: string; dir: string } | null>() // 디렉터리 → 레포 뿌리와 그 디렉터리의 레포 안 경로
  const refs = new Map<string, { ref: string; at: Date } | null>()
  const files = new Map<string, Set<string> | null>() // "뿌리\0경로" → 기준 브랜치의 줄 집합
  const ignored = new Map<string, boolean>()
  const rows: Array<typeof editSurvival.$inferInsert> = []
  const now = new Date()

  for (const e of edits) {
    const added = addedLines(e.oldText, e.newText)
    if (added.length === 0) continue
    const dir = dirname(e.filePath)
    if (!roots.has(dir)) {
      const found = await repoOf(e.filePath)
      roots.set(dir, found ? { root: found.root, dir: dirname(found.rel) } : null)
    }
    const hit = roots.get(dir)
    if (!hit) continue // 레포 밖(임시 폴더, 지운 worktree) — 비교할 기준이 없다
    const root = hit.root
    if (!refs.has(root)) refs.set(root, await baseRef(root))
    const base = refs.get(root)
    if (!base) continue
    const rel = join(hit.dir, basename(e.filePath))
    const key = `${root}\u0000${rel}`
    // git 이 무시하는 파일(.agents/scratch 의 계획 메모 등)은 애초에 남기려고 쓴 게 아니다. 재지 않는다.
    // 2026-09-30 appius 의 "기준 브랜치에 파일 없음" 369건 가운데 상당수가 이 메모였다.
    if (!ignored.has(key)) ignored.set(key, await git(root, 'check-ignore', '-q', rel).then(() => true, () => false))
    if (ignored.get(key)) continue
    if (!files.has(key)) {
      try {
        files.set(key, new Set(lines(await git(root, 'show', `${base.ref}:${rel}`))))
      } catch {
        files.set(key, null) // 기준 브랜치에 그 파일이 없다
      }
    }
    const content = files.get(key)
    rows.push({
      editId: e.id,
      repo: root.split('/').pop()!,
      ref: base.ref,
      refAt: base.at,
      fileFound: content !== null,
      added: added.length,
      kept: content ? added.filter((l) => content.has(l)).length : 0,
      checkedAt: now,
    })
  }

  // 스냅숏이라 통째로 갈아 끼운다. 트랜잭션이라 읽는 쪽은 옛 스냅숏이나 새 스냅숏만 본다.
  await db.transaction(async (tx) => {
    await tx.delete(editSurvival)
    for (let i = 0; i < rows.length; i += 500) await tx.insert(editSurvival).values(rows.slice(i, i + 500))
  })
  return { edits: edits.length, measured: rows.length, repos: [...refs].filter(([, r]) => r).length }
}
