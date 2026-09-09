import { readFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { Type, type Static } from 'typebox'
import type { App } from './app.js'
import { Nullable } from './schemas.js'

// 브레인 건강 패널.
//
// suah-brain 레포(~/workspace/suah-brain)는 판단 기준을 담은 마크다운 문서 모음이다. 알려진 문제는
// "은퇴가 없다": 문서를 supersede 하지 않고 쌓기만 하고, inbox 항목이 승격되지 않은 채 늙는다.
// 이 라우트는 그 상태를 숫자로 바꾼다. DB가 아니라 파일 시스템과 git 을 직접 읽는 첫 데이터 소스다.
//
// 읽는 것 셋:
//   1) 문서 frontmatter (--- 사이의 id/kind/status/updated) → 상태 분포, 오래된 active 문서
//   2) inbox.md 의 "- YYYY-MM-DD ..." 항목 → 개수, 가장 오래된 항목 나이
//   3) git log → 주별 문서 커밋 수(승격 주기), 7월 기준선과 비교
//
// 저장하지 않고 요청마다 계산한다. 파일 50개, git log 한 번이라 수십 ms. 추세가 필요해지면 일별
// 스냅샷 테이블을 붙인다.

const BRAIN_DIR = process.env.BRAIN_DIR ?? join(homedir(), 'workspace', 'suah-brain')
// AGENTS.md는 "inbox 정리 때 오래된 active 문서를 검토"라고만 하고 기한은 없다. 60일로 시작한다.
const STALE_DAYS = 60
const CADENCE_WEEKS = 8

const execFileAsync = promisify(execFile)

const StaleDoc = Type.Object({
  id: Type.String(),
  path: Type.String(),
  kind: Type.String(),
  updated: Type.String({ description: 'frontmatter의 updated, YYYY-MM-DD' }),
  ageDays: Type.Integer(),
})

const WeekCount = Type.Object({
  week: Type.String({ description: 'ISO 주, 예 2026-W36' }),
  commits: Type.Integer(),
})

const BrainReport = Type.Object({
  dir: Type.String(),
  docs: Type.Object({
    total: Type.Integer({ description: 'frontmatter가 있는 문서 수' }),
    active: Type.Integer(),
    draft: Type.Integer(),
    superseded: Type.Integer(),
    other: Type.Integer({ description: 'status 값이 셋 중 어느 것도 아닌 문서' }),
  }),
  staleDays: Type.Integer(),
  stale: Type.Array(StaleDoc, { description: `active 인데 updated 가 ${STALE_DAYS}일 넘은 문서, 오래된 순` }),
  inbox: Type.Object({
    items: Type.Integer(),
    undated: Type.Integer({ description: '날짜 접두어가 없어 나이를 모르는 항목' }),
    oldestAgeDays: Nullable(Type.Integer()),
  }),
  cadence: Type.Object({
    weeks: Type.Array(WeekCount),
    // 2026년 7월(W27~W31) 주당 평균 승격 커밋. 브레인 문서가 "7월 주간 기준선"이라 부르는 값.
    julyBaselinePerWeek: Type.Number(),
    last4WeeksPerWeek: Type.Number(),
  }),
})

type Frontmatter = { id?: string; kind?: string; status?: string; updated?: string }

// 파일 맨 앞 "---" 블록만 읽는다. YAML 파서 없이 "key: value" 줄만 본다. 이 레포의 frontmatter는
// 전부 그 형태다. 주석(# ...)은 잘라낸다.
function parseFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end === -1) return null
  const fm: Frontmatter = {}
  for (const raw of text.slice(4, end).split('\n')) {
    const line = raw.split('#')[0]!.trim()
    const m = /^(id|kind|status|updated):\s*(.+)$/.exec(line)
    if (m) fm[m[1] as keyof Frontmatter] = m[2]!.trim().replace(/^"|"$/g, '')
  }
  return fm
}

// git 의 %G-W%V 와 같은 ISO 주 키("2026-W36"). 월요일 시작, 그 해 첫 목요일이 있는 주가 W01.
function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7 // 일요일을 7로
  date.setUTCDate(date.getUTCDate() + 4 - day) // 그 주의 목요일로 이동
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)

// 승격(promotion) = inbox 에 모인 것을 distilled 레이어로 올리는 것.
// 그래서 identity/knowledge/workflows/decisions 를 건드린 커밋만 센다.
// 뺀 것과 이유:
//   - inbox.md: 수집이지 승격이 아니다.
//   - projects/: 프로젝트 진행 기록(Status 로그)이다. 규칙 승격이 아닌데 예전엔 여기 커밋이
//     주별 수의 최대 버킷이라 cadence 를 두 배 가까이 부풀렸다(2026-09-09 확인).
//   - evals/, .agent/, AGENTS.md, README, scripts/: 테스트·스킬 정의·메타·도구. 규칙 승격이 아니다.
const PROMOTION_DIRS = ['identity/', 'knowledge/', 'workflows/', 'decisions/']

async function weeklyDocCommits(since: string, until?: string): Promise<Map<string, number>> {
  const args = ['log', `--since=${since}`, '--format=%ad', '--date=format:%G-W%V', '--', ...PROMOTION_DIRS]
  if (until) args.splice(2, 0, `--until=${until}`)
  const { stdout } = await execFileAsync('git', args, { cwd: BRAIN_DIR })
  const counts = new Map<string, number>()
  for (const w of stdout.split('\n').filter(Boolean)) counts.set(w, (counts.get(w) ?? 0) + 1)
  return counts
}

export function brainRoutes(app: App) {
  app.get('/harness/brain', { schema: { response: { 200: BrainReport } } }, async () => {
    // 1) 문서
    const docs = { total: 0, active: 0, draft: 0, superseded: 0, other: 0 }
    const stale: Array<Static<typeof StaleDoc>> = []
    for await (const path of glob(join(BRAIN_DIR, '**', '*.md'), { exclude: (p) => p.includes('/.git/') })) {
      const fm = parseFrontmatter(await readFile(path, 'utf8'))
      if (!fm) continue // README, AGENTS.md 같은 frontmatter 없는 파일은 문서가 아니다
      docs.total++
      if (fm.status === 'active') docs.active++
      else if (fm.status === 'draft') docs.draft++
      else if (fm.status === 'superseded') docs.superseded++
      else docs.other++

      if (fm.status === 'active' && fm.updated && /^\d{4}-\d{2}-\d{2}$/.test(fm.updated)) {
        const ageDays = daysSince(fm.updated)
        if (ageDays > STALE_DAYS) {
          stale.push({
            id: fm.id ?? relative(BRAIN_DIR, path),
            path: relative(BRAIN_DIR, path),
            kind: fm.kind ?? '-',
            updated: fm.updated,
            ageDays,
          })
        }
      }
    }
    stale.sort((a, b) => b.ageDays - a.ageDays)

    // 2) inbox
    const inboxText = await readFile(join(BRAIN_DIR, 'inbox.md'), 'utf8').catch(() => '')
    const items = inboxText.split('\n').filter((l) => l.startsWith('- '))
    let undated = 0
    let oldest: number | null = null
    for (const it of items) {
      const m = /^- (\d{4}-\d{2}-\d{2})/.exec(it)
      if (!m) {
        undated++
        continue
      }
      const age = daysSince(m[1]!)
      if (oldest === null || age > oldest) oldest = age
    }

    // 3) 승격 주기
    const sinceDate = new Date(Date.now() - CADENCE_WEEKS * 7 * 86400000).toISOString().slice(0, 10)
    const recent = await weeklyDocCommits(sinceDate)
    const july = await weeklyDocCommits('2026-07-01', '2026-08-01')
    const julyWeeks = Math.max(1, july.size)
    const julyTotal = [...july.values()].reduce((a, b) => a + b, 0)
    // 커밋 없는 주도 0으로 채운다. 빈 주가 빠지면 "최근 4주 평균"이 실제보다 높게 나온다.
    const weeks: Array<{ week: string; commits: number }> = []
    for (let i = CADENCE_WEEKS - 1; i >= 0; i--) {
      const key = isoWeek(new Date(Date.now() - i * 7 * 86400000))
      weeks.push({ week: key, commits: recent.get(key) ?? 0 })
    }
    const last4 = weeks.slice(-4).reduce((a, w) => a + w.commits, 0) / 4

    return {
      dir: BRAIN_DIR.replace(homedir(), '~'),
      docs,
      staleDays: STALE_DAYS,
      stale,
      inbox: { items: items.length, undated, oldestAgeDays: oldest },
      cadence: { weeks, julyBaselinePerWeek: julyTotal / julyWeeks, last4WeeksPerWeek: last4 },
    }
  })
}
