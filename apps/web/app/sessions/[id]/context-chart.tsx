import { fmtNum } from '../../format'
import type { ApiData } from '../../server'

type Turn = ApiData<'/sessions/{id}'>['turns'][number]

// 한 턴의 컨텍스트 크기 = 그 턴에 모델이 읽은 입력 전체.
// 새로 보낸 것(input) + 캐시에서 읽은 것(cacheRead) + 이번에 캐시에 쓴 것(cacheCreation).
// 출력은 뺀다. 출력은 이 턴이 만든 것이지 들고 있던 게 아니다.
const ctxSize = (t: Turn) => t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens

// 세션이 진행되며 컨텍스트가 어떻게 자랐는지. 한 열이 한 턴이다.
//
// 왜 필요한가: 운반 비중(/sessions 의 carry %)은 "이 세션은 84%가 운반"까지만 말한다.
// 어디서 그렇게 됐는지는 못 말한다. 곡선이 계단처럼 뛰는 지점이 큰 게 들어온 순간이고,
// 그 뒤로는 그 크기를 턴마다 계속 다시 읽는다. 뛴 자리가 곧 비용이 붙기 시작한 자리다.
//
// 서브에이전트를 갈라 그리는 이유(2026-09-29 첫 버전의 오독을 고친 것):
// 서브에이전트는 자기만의 컨텍스트 창을 쓴다. 메인 대화와 같은 색으로 한 줄에 그리면
// 창 두 개가 시간순으로 번갈아 찍혀 톱니가 되고, 그 골이 압축처럼 보인다. 실제로
// haiku 서브에이전트(20~40K)와 메인 대화(100K+)가 섞인 세션에서 그렇게 보였다.
//
// /compact 로 컨텍스트가 줄어드는 경우는 따로 표시하지 않는다. 현재 데이터 전체에서
// 메인 대화가 직전 메인 턴보다 절반 아래로 떨어진 적이 0건이라, 표시 규칙을 넣어도
// 한 번도 렌더되지 않고 임계값도 검증할 수 없다. 실제 사례가 생기면 그때 만든다.
//
// 상호작용은 없다(서버 컴포넌트). 값은 title 로 브라우저 툴팁에 맡긴다.
export function ContextChart({ turns, stamp }: { turns: Turn[]; stamp: (iso: string) => string }) {
  if (turns.length === 0) return null
  const max = Math.max(...turns.map(ctxSize))

  const subCount = turns.filter((t) => t.sidechain).length

  return (
    <>
      <div className="chart is-dense" role="img" aria-label="턴별 컨텍스트 크기">
        <span className="chart-max">{fmtNum(max)} 토큰</span>
        {turns.map((t) => {
          const size = ctxSize(t)
          return (
            <div
              key={t.id}
              className={`chart-col${t.sidechain ? ' is-sub' : ''}`}
              title={`${stamp(String(t.ts))} · ${fmtNum(size)} 토큰${t.sidechain ? ' · 서브에이전트' : ''}`}
            >
              {/* 높이는 데이터값이라 인라인. DESIGN.md 7절의 예외. */}
              <div className="bar" style={{ height: max ? `${(size / max) * 100}%` : '1px' }} />
            </div>
          )
        })}
      </div>
      <p className="summary">
        메인 <strong>{turns.length - subCount}</strong>턴
        {subCount > 0 && (
          <>
            {' · '}서브에이전트 <strong>{subCount}</strong>턴(옅은 색, 별도 컨텍스트 창)
          </>
        )}
      </p>
    </>
  )
}
