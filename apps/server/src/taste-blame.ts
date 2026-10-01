// 커밋 기준 남긴 비율(commit_survival)과 지금 줄 주인(taste_ownership). pnpm taste 가 같이 돌린다.
//
// 도구 입력(agent_edits)이 아니라 git 이력을 본다. Bash 로 고친 파일도 커밋에 들어가면 여기서 잡힌다.
//
// 흐름(레포마다):
//   1. 에이전트 커밋: 기준 ref 에서 수아 명의 + "Co-Authored-By: Claude" 표시가 있는 커밋.
//   2. 커밋마다 더한 줄의 내용(git show -U0 의 + 줄).
//   3. 남은 줄 = 그 내용이 기준 ref 의 같은 파일에 아직 있는 줄. edit_survival 과 같은 내용 비교다.
//   4. 줄 주인은 따로 git blame 으로 센다: 지금 줄을 마지막으로 쓴 커밋이 에이전트/수아 손/남 중 무엇인가.
//
// 남은 줄을 blame 으로 세지 않는 이유: 처음엔 그랬다. 그런데 intelligence-driver-android 의 에이전트 커밋
// 10개가 전부 0 이 나왔다. 팀원이 그 머지를 되돌렸다가 "Reapply" 커밋으로 다시 넣어서, 내용은 그대로인데
// blame 은 그 줄을 Reapply 커밋 것으로 친다. revert·cherry-pick·rebase 가 있으면 blame 은 주인을 잃는다.
// 내용 비교는 그런 이력에 흔들리지 않는다. 대신 "누가 마지막으로 만졌나"는 모르니 그건 blame 에 맡긴다.
//
// 줄 주인(blame)의 한계는 그대로 남는다: Reapply 로 들어간 에이전트 줄은 남의 줄로 센다.

import { access } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { commitSurvival, sessions, tasteOwnership } from './db/schema.js'
import { baseRef, git } from './taste.js'

const MIN_LINE = 4
export const norm = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= MIN_LINE)

// 이 날 이후 커밋만 커밋별 표에 넣는다. 에이전트 하네스를 본격적으로 쓴 때부터다.
// 줄 주인 판정에는 날짜와 상관없이 모든 에이전트 커밋을 쓴다(옛 에이전트 커밋을 수아 손으로 세지 않게).
const SINCE = '2026-07-01'
// 잠금 파일은 사람도 에이전트도 "쓴" 게 아니다. 세면 비율이 잠금 파일 크기에 끌려간다.
const SKIP = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Podfile\.lock|Cargo\.lock)$/
const BLAME_CONCURRENCY = 6
export const TRAILER = 'Co-Authored-By: Claude'

// 세션을 연 폴더들의 레포. 같은 레포의 worktree 는 하나로 묶는다 — 이력이 같아서 따로 세면 두 번 센다
// (2026-09-30 첫 실행에서 appius 와 그 worktree 가 같은 숫자로 두 줄 나왔다). 묶는 키는 git 공통 디렉터리,
// 이름은 그 레포 본체(공통 디렉터리의 부모)의 폴더 이름이다.
export async function roots() {
  const cwds = (await db.selectDistinct({ cwd: sessions.cwd }).from(sessions)).map((r) => r.cwd)
  const out = new Map<string, string>() // 공통 디렉터리 → 대표 작업 폴더
  for (const cwd of cwds) {
    try {
      await access(cwd)
      const common = (await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim()
      if (!out.has(common)) out.set(common, (await git(cwd, 'rev-parse', '--show-toplevel')).trim())
    } catch {
      /* 지운 worktree, 레포 밖 */
    }
  }
  return [...out].map(([common, root]) => ({ root, name: common.replace(/\/\.git\/?$/, '').split('/').pop()! }))
}

// 줄마다 쓴 커밋을 센다. --line-porcelain 은 줄마다 머리(커밋 해시 …)를 반복해서 한 줄씩 셀 수 있다.
async function blame(root: string, ref: string, path: string) {
  const counts = new Map<string, number>()
  let out: string
  try {
    out = await git(root, 'blame', '-w', '--line-porcelain', ref, '--', path)
  } catch {
    return null // 기준 ref 에 그 파일이 없다(지웠거나 머지 전)
  }
  let sha = ''
  for (const line of out.split('\n')) {
    if (/^[0-9a-f]{40} /.test(line)) sha = line.slice(0, 40)
    else if (line.startsWith('\t')) counts.set(sha, (counts.get(sha) ?? 0) + 1)
  }
  return counts
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]!) }))
}

export async function measureCommits() {
  const now = new Date()
  const commitRows: Array<typeof commitSurvival.$inferInsert> = []
  const ownRows: Array<typeof tasteOwnership.$inferInsert> = []

  for (const { root, name: repo } of await roots()) {
    const base = await baseRef(root)
    if (!base) continue
    const me = (await git(root, 'config', 'user.email').catch(() => '')).trim()
    if (!me) continue
    const log = async (...extra: string[]) =>
      (await git(root, 'log', base.ref, '--no-merges', `--author=${me}`, '-i', `--grep=${TRAILER}`, ...extra))
        .split('\n')
        .filter(Boolean)
    const agentAll = new Set(await log('--format=%H'))
    const mine = new Set((await git(root, 'log', base.ref, '--no-merges', `--author=${me}`, '--format=%H')).split('\n').filter(Boolean))
    const recent = (await log(`--since=${SINCE}`, '--format=%H%x09%cI%x09%s')).map((l) => {
      const [sha, at, ...subj] = l.split('\t')
      return { sha: sha!, at: new Date(at!), subject: subj.join('\t') }
    })
    if (recent.length === 0) continue

    // 커밋마다 파일별로 더한 줄의 내용. -U0 은 문맥 줄 없이 바뀐 줄만 준다. --no-renames 라 옮긴 파일은
    // 새 이름에 전부 더한 것으로 나온다 — 옮기기만 한 커밋은 내용 비교에서 그대로 남은 것으로 잡힌다.
    const addedByCommit = new Map<string, Array<{ path: string; lines: string[] }>>()
    const files = new Set<string>()
    for (const c of recent) {
      const perFile: Array<{ path: string; lines: string[] }> = []
      let path: string | null = null
      let buf: string[] = []
      const flush = () => {
        if (path && buf.length) perFile.push({ path, lines: norm(buf.join('\n')) })
        buf = []
      }
      for (const l of (await git(root, 'show', '-U0', '--no-renames', '--format=', c.sha)).split('\n')) {
        if (l.startsWith('+++ ')) {
          flush()
          const p = l.slice(4)
          path = p === '/dev/null' ? null : p.replace(/^b\//, '')
          if (path && SKIP.test(path)) path = null
        } else if (l.startsWith('+') && path) buf.push(l.slice(1))
      }
      flush()
      for (const f of perFile) files.add(f.path)
      addedByCommit.set(c.sha, perFile)
    }

    // 기준 ref 의 파일 내용(줄 집합). 파일마다 한 번.
    const baseLines = new Map<string, Set<string> | null>()
    await pool([...files], BLAME_CONCURRENCY, async (path) => {
      baseLines.set(path, await git(root, 'show', `${base.ref}:${path}`).then((t) => new Set(norm(t)), () => null))
    })

    // 줄 주인: 건드린 파일을 한 번씩 blame
    const own = { agent: 0, mine: 0, other: 0 }
    let fileCount = 0
    await pool([...files], BLAME_CONCURRENCY, async (path) => {
      const counts = await blame(root, base.ref, path)
      if (!counts) return
      fileCount++
      for (const [sha, n] of counts) {
        if (agentAll.has(sha)) own.agent += n
        else if (mine.has(sha)) own.mine += n
        else own.other += n
      }
    })

    for (const c of recent) {
      let a = 0
      let k = 0
      for (const f of addedByCommit.get(c.sha) ?? []) {
        const have = baseLines.get(f.path)
        a += f.lines.length
        if (have) k += f.lines.filter((l) => have.has(l)).length
      }
      if (a === 0) continue
      commitRows.push({ repo, sha: c.sha, committedAt: c.at, subject: c.subject.slice(0, 200), added: a, kept: k, ref: base.ref, checkedAt: now })
    }
    ownRows.push({ repo, ref: base.ref, files: fileCount, agentLines: own.agent, mineLines: own.mine, otherLines: own.other, checkedAt: now })
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`truncate ${commitSurvival}, ${tasteOwnership}`)
    for (let i = 0; i < commitRows.length; i += 500) await tx.insert(commitSurvival).values(commitRows.slice(i, i + 500))
    if (ownRows.length) await tx.insert(tasteOwnership).values(ownRows)
  })
  return { commits: commitRows.length, repos: ownRows.length }
}
