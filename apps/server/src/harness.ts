import { Type } from 'typebox'
import { sql } from 'drizzle-orm'
import type { App } from './app.js'
import { db } from './db/index.js'
import { skillInvocations, gateEvents } from './db/schema.js'
import { DateTime, Nullable } from './schemas.js'

// 하네스 건강: 규칙이 살아 있나(/harness/rules).
//
// 2026-09-08 여기 있던 "좀비 세션 레이더"(/harness/zombies)를 뺐다. 전제는 "훅 설정은 세션 시작 때
// 스냅샷되어 오래 산 세션은 새 훅을 못 받는다"였는데, 살아 있는 세션에 UserPromptSubmit 훅을
// 추가하는 실험으로 현재 버전(2.1.x)은 파일 워처가 즉시 반영함을 확인했다. 재시작할 이유가 없으니
// 화면도 없다. 전제가 바뀌면 git 이력(587ff56)에서 되살릴 수 있다.

// ---------------------------------------------------------------------------
// 죽은 규칙 알람.
//
// 이 프로젝트의 출발점은 suah-judge 라우터가 한 달 동안 조용히 죽어 있었던 사건이다.
// 아무도 에러를 못 봤다. 훅은 실패하지 않았고, 그냥 안 불렸다. 그런 "조용한 침묵"은
// 에러 로그로는 잡을 수 없고, "평소엔 얼마나 자주 울렸나"와 "지금 얼마나 오래 조용한가"를
// 비교해야 보인다. 여기서 "규칙"은 스킬 하나, 또는 게이트 트리거 하나다.
//
// 판정 방식:
//   median_gap  = 그 규칙의 연속 호출 사이 간격의 중앙값(일). 평균 대신 중앙값인 이유는
//                 한 세션에서 몰아 부른 짧은 간격이나 휴가 같은 긴 공백 하나에 흔들리지 않게.
//   silence     = 마지막 호출 이후 지금까지(일)
//   dead        = silence > max(3 × median_gap, 7일)   ← 매일 쓰던 것도 최소 일주일은 기다린다
//   quiet       = silence > 1.5 × median_gap
//   insufficient= 호출이 MIN_EVENTS 미만. 간격 통계를 낼 수 없다
//
// 한계: 의도적으로 은퇴시킨 스킬도 dead로 나온다. 그건 버그가 아니라 이 화면이 묻는 질문이다.
// "이거 죽은 건가, 버린 건가?" 답은 사람이 한다.

const MIN_EVENTS = 5
const DEAD_MULTIPLIER = 3
const QUIET_MULTIPLIER = 1.5
const DEAD_FLOOR_DAYS = 7

const RuleHealth = Type.Object({
  name: Type.String({ description: '스킬 이름, 또는 "gate:<trigger>"' }),
  kind: Type.Union([Type.Literal('skill'), Type.Literal('gate')]),
  status: Type.Union([
    Type.Literal('dead'),
    Type.Literal('quiet'),
    Type.Literal('ok'),
    Type.Literal('insufficient'),
  ]),
  total: Type.Integer(),
  firstAt: DateTime,
  lastAt: DateTime,
  silenceDays: Type.Number(),
  medianGapDays: Nullable(Type.Number({ description: '호출 2회 미만이면 null' })),
})

const RulesReport = Type.Object({
  thresholds: Type.Object({
    minEvents: Type.Integer(),
    deadMultiplier: Type.Number(),
    quietMultiplier: Type.Number(),
    deadFloorDays: Type.Integer(),
  }),
  rules: Type.Array(RuleHealth),
})

type Status = 'dead' | 'quiet' | 'ok' | 'insufficient'

function judge(total: number, silenceDays: number, medianGapDays: number | null): Status {
  if (total < MIN_EVENTS || medianGapDays === null) return 'insufficient'
  if (silenceDays > Math.max(DEAD_MULTIPLIER * medianGapDays, DEAD_FLOOR_DAYS)) return 'dead'
  if (silenceDays > QUIET_MULTIPLIER * medianGapDays) return 'quiet'
  return 'ok'
}

const STATUS_ORDER: Record<Status, number> = { dead: 0, quiet: 1, ok: 2, insufficient: 3 }

export function harnessRoutes(app: App) {
  app.get('/harness/rules', { schema: { response: { 200: RulesReport } } }, async () => {
    // 세 단계 CTE.
    //  ev   : 스킬 호출과 게이트 울림을 한 목록으로. 게이트는 nudged만 센다(throttled는 "울림"이 아니다).
    //  gaps : LAG 윈도우 함수로 "같은 규칙의 직전 호출"을 옆에 가져와 간격을 계산한다.
    //         윈도우 함수는 GROUP BY와 달리 행을 합치지 않고 각 행에 이웃 정보를 붙인다.
    //  최종 : 규칙별로 개수, 처음/마지막, 간격 중앙값(percentile_cont), 침묵 일수.
    const result = await db.execute<{
      name: string
      kind: 'skill' | 'gate'
      total: number
      first_at: string
      last_at: string
      median_gap_days: number | null
      silence_days: number
    }>(sql`
      with ev as (
        select ${skillInvocations.skill} as name, 'skill' as kind, ${skillInvocations.ts} as ts
        from ${skillInvocations}
        union all
        select 'gate:' || ${gateEvents.triggerSkill}, 'gate', ${gateEvents.ts}
        from ${gateEvents}
        where ${gateEvents.outcome} = 'nudged'
      ),
      gaps as (
        select
          name, kind, ts,
          extract(epoch from ts - lag(ts) over (partition by name order by ts)) / 86400.0 as gap_days
        from ev
      )
      select
        name,
        kind,
        count(*)::int as total,
        min(ts) as first_at,
        max(ts) as last_at,
        percentile_cont(0.5) within group (order by gap_days) as median_gap_days,
        extract(epoch from now() - max(ts)) / 86400.0 as silence_days
      from gaps
      group by name, kind
    `)

    const rules = result.rows
      .map((r) => {
        const total = Number(r.total)
        const silenceDays = Number(r.silence_days)
        const medianGapDays = r.median_gap_days === null ? null : Number(r.median_gap_days)
        return {
          name: r.name,
          kind: r.kind,
          status: judge(total, silenceDays, medianGapDays),
          total,
          firstAt: r.first_at,
          lastAt: r.last_at,
          silenceDays,
          medianGapDays,
        }
      })
      // 죽은 것 먼저, 같은 상태 안에서는 오래 조용한 것 먼저.
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.silenceDays - a.silenceDays)

    return {
      thresholds: {
        minEvents: MIN_EVENTS,
        deadMultiplier: DEAD_MULTIPLIER,
        quietMultiplier: QUIET_MULTIPLIER,
        deadFloorDays: DEAD_FLOOR_DAYS,
      },
      rules,
    }
  })
}
