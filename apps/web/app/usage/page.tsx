import { Nav } from '../nav'
import { fetchJson } from '../server'

type RepoUsage = {
  repo: string
  sessions: number
  turns: number
  inputTokens: number
  outputTokens: number
  lastSeenAt: string | null
}

type SkillUsage = {
  skill: string
  invocations: number
  lastUsedAt: string
}

const fmt = new Intl.NumberFormat('en-US')
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '-')

export default async function UsagePage() {
  // 두 요청은 서로 독립이라 동시에 보낸다. 순서대로 await 하면 대기 시간이 합쳐진다.
  let repos: RepoUsage[]
  let skills: SkillUsage[]
  try {
    ;[repos, skills] = await Promise.all([
      fetchJson<RepoUsage[]>('/usage/repos'),
      fetchJson<SkillUsage[]>('/usage/skills'),
    ])
  } catch (err) {
    return (
      <main>
        <Nav />
        <h1>usage</h1>
        <p style={{ color: 'crimson' }}>
          서버에서 데이터를 못 받았어요. Fastify(4000)가 켜져 있는지 확인하세요.
        </p>
        <pre>{err instanceof Error ? err.message : String(err)}</pre>
      </main>
    )
  }

  if (repos.length === 0) {
    return (
      <main>
        <Nav />
        <h1>usage</h1>
        <p>아직 데이터가 없어요. 서버 폴더에서 <code>pnpm ingest:transcripts</code> 를 실행하세요.</p>
      </main>
    )
  }

  return (
    <main>
      <Nav />
      <h1>usage</h1>

      <h2>레포별</h2>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #999' }}>
            <th>repo</th>
            <th style={{ textAlign: 'right' }}>sessions</th>
            <th style={{ textAlign: 'right' }}>turns</th>
            <th style={{ textAlign: 'right' }}>input tokens</th>
            <th style={{ textAlign: 'right' }}>output tokens</th>
            <th>last seen</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((r) => (
            <tr key={r.repo}>
              <td>{r.repo}</td>
              <td style={{ textAlign: 'right' }}>{r.sessions}</td>
              <td style={{ textAlign: 'right' }}>{fmt.format(r.turns)}</td>
              <td style={{ textAlign: 'right' }}>{fmt.format(r.inputTokens)}</td>
              <td style={{ textAlign: 'right' }}>{fmt.format(r.outputTokens)}</td>
              <td>{day(r.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>스킬별</h2>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #999' }}>
            <th>skill</th>
            <th style={{ textAlign: 'right' }}>invocations</th>
            <th>last used</th>
          </tr>
        </thead>
        <tbody>
          {skills.map((s) => (
            <tr key={s.skill}>
              <td>{s.skill}</td>
              <td style={{ textAlign: 'right' }}>{s.invocations}</td>
              <td>{day(s.lastUsedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
