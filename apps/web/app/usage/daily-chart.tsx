import { fmtUsd } from '../format'
import type { ApiData } from '../server'

export type DailyUsage = ApiData<'/usage/daily'>[number]

// 서버 컴포넌트. 상호작용 없음. hover 툴팁은 title 속성으로 브라우저에 맡긴다.
export function DailyChart({ days }: { days: DailyUsage[] }) {
  const max = Math.max(0, ...days.map((d) => d.costUsd))
  return (
    <div className="chart" role="img" aria-label="일별 API 환산 비용">
      <span className="chart-max">{fmtUsd(max)}</span>
      {days.map((d) => {
        const date = new Date(`${d.day}T00:00:00`)
        // 월요일에만 날짜 라벨. 전부 붙이면 겹치고, 1일까지 붙이면 월요일과 붙는 주에 겹친다.
        const showLabel = date.getDay() === 1
        return (
          <div
            key={d.day}
            className={`chart-col${d.costUsd === 0 ? ' is-zero' : ''}`}
            title={`${d.day} · ${fmtUsd(d.costUsd)} · 세션 ${d.sessions} · 응답 ${d.turns}`}
          >
            {/* 높이는 데이터값이라 인라인. */}
            <div className="bar" style={{ height: max ? `${(d.costUsd / max) * 100}%` : '1px' }} />
            {showLabel && <span className="chart-label">{d.day.slice(5)}</span>}
          </div>
        )
      })}
    </div>
  )
}
