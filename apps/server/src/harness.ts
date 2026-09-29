import { Type } from 'typebox'
import { sql } from 'drizzle-orm'
import type { App } from './app.js'
import { db } from './db/index.js'
import { skillInvocations, gateEvents, turns } from './db/schema.js'
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
// 단위는 달력 날짜가 아니라 "활동일"이다 — Claude Code 를 쓴 흔적이 하나라도 있는 날.
// 2026-09-29 확인한 오탐 때문이다. 09-22~09-29 엿새를 쉬었더니 하루 주기로 쓰던 스킬
// 여섯 개가 전부 dead 로 떴다. 침묵 일수가 전부 7.7~7.8일로 같았는데, 규칙 여섯 개가
// 같은 날 동시에 죽는 일은 없다. 하나의 사건 — 쉬는 날을 침묵으로 센 것이다.
// 활동일로 다시 재니 그 여섯은 침묵 2일이었고 dead 12개가 4개로 줄었다.
//
// 침묵과 중앙간격을 둘 다 활동일로 잰다. 한쪽만 바꾸면 단위가 어긋나 전부 건강해 보인다.
//
// 판정 방식:
//   median_gap  = 그 규칙의 연속 호출 사이 간격의 중앙값(활동일). 평균 대신 중앙값인 이유는
//                 한 세션에서 몰아 부른 짧은 간격 하나에 흔들리지 않게.
//   silence     = 마지막 호출 이후 지난 활동일 수
//   dead        = silence > max(3 × median_gap, 7)   ← 매일 쓰던 것도 최소 7 활동일은 기다린다
//   quiet       = silence > 1.5 × median_gap
//   insufficient= 호출이 MIN_EVENTS 미만. 간격 통계를 낼 수 없다
//
// 한계 1: 의도적으로 은퇴시킨 스킬도 dead로 나온다. 그건 버그가 아니라 이 화면이 묻는 질문이다.
// "이거 죽은 건가, 버린 건가?" 답은 사람이 한다.
//
// 한계 2: 활동일은 이벤트가 있는 날로 정의되므로, 훅이 통째로 죽으면 활동일이 안 늘고
// 아무것도 dead 로 안 잡힌다. 전면 장애가 가장 조용해지는 역설이다. 그래서 규칙별 판정과
// 별개로 harness 블록(아래)이 "일하고 있는데 하네스 이벤트가 0건"을 따로 본다.

const MIN_EVENTS = 5
const DEAD_MULTIPLIER = 3
const QUIET_MULTIPLIER = 1.5
const DEAD_FLOOR_DAYS = 7
// 일하고 있는데(turns 가 있는데) 하네스 이벤트가 이 활동일 수만큼 0건이면 하네스를 의심한다.
// 주말 이틀은 정상이고, 사흘째 완전 침묵이면 훅 쪽을 본다.
const HARNESS_SILENT_DAYS = 3

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
  // 단위는 활동일이다. 이름에 박아두지 않으면 달력 날짜로 읽힌다.
  silenceActiveDays: Type.Integer(),
  medianGapActiveDays: Nullable(Type.Number({ description: '호출 2회 미만이면 null' })),
})

// 규칙별 판정과 별개인 시스템 전체 판정. 규칙 알람이 활동일에 기대는 이상,
// "활동일 자체가 안 생기는" 전면 장애는 다른 눈으로 봐야 한다.
const HarnessHealth = Type.Object({
  lastEventAt: Nullable(DateTime),
  // 마지막 하네스 이벤트 이후 사용자가 Claude Code 를 쓴 날 수.
  silentActiveDays: Type.Integer(),
  alarm: Type.Boolean(),
})

const RulesReport = Type.Object({
  thresholds: Type.Object({
    minEvents: Type.Integer(),
    deadMultiplier: Type.Number(),
    quietMultiplier: Type.Number(),
    deadFloorDays: Type.Integer(),
    harnessSilentDays: Type.Integer(),
  }),
  harness: HarnessHealth,
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
    // 네 단계 CTE.
    //  active : 활동일 목록에 번호를 매긴다. turns 를 넣는 이유는 "사용자가 일한 날"의
    //           가장 넓은 증거이기 때문이다. 스킬 이벤트만으로 활동일을 세면, 일은 했는데
    //           스킬을 안 쓴 날이 빠져서 그 스킬의 침묵이 실제보다 짧게 잡힌다.
    //  ev     : 스킬 호출과 게이트 울림을 한 목록으로. 게이트는 nudged만(throttled는 "울림"이 아니다).
    //  gaps   : 각 이벤트를 활동일 번호로 바꾼 뒤 LAG 로 직전 번호와의 차를 낸다.
    //           달력 날짜가 아니라 번호끼리 빼므로 쉬는 날이 간격에 안 섞인다.
    //  최종   : 규칙별 개수, 처음/마지막, 간격 중앙값, 마지막 이후 흐른 활동일 수.
    const result = await db.execute<{
      name: string
      kind: 'skill' | 'gate'
      total: number
      first_at: string
      last_at: string
      median_gap_days: number | null
      silence_days: number
    }>(sql`
      with active as (
        select d, row_number() over (order by d) as idx
        from (
          select distinct ${turns.ts}::date as d from ${turns}
          union select distinct ${skillInvocations.ts}::date from ${skillInvocations}
          union select distinct ${gateEvents.ts}::date from ${gateEvents}
        ) x
      ),
      ev as (
        select ${skillInvocations.skill} as name, 'skill' as kind, ${skillInvocations.ts} as ts
        from ${skillInvocations}
        union all
        select 'gate:' || ${gateEvents.triggerSkill}, 'gate', ${gateEvents.ts}
        from ${gateEvents}
        where ${gateEvents.outcome} = 'nudged'
      ),
      gaps as (
        select
          e.name, e.kind, e.ts, a.idx,
          a.idx - lag(a.idx) over (partition by e.name order by a.idx) as gap_days
        from ev e join active a on a.d = e.ts::date
      )
      select
        name,
        kind,
        count(*)::int as total,
        min(ts) as first_at,
        max(ts) as last_at,
        percentile_cont(0.5) within group (order by gap_days) as median_gap_days,
        ((select max(idx) from active) - max(idx))::int as silence_days
      from gaps
      group by name, kind
    `)

    // 시스템 전체 판정. 마지막 하네스 이벤트 이후 사용자가 일한 날이 며칠인가.
    // turns 는 있는데 이벤트가 없는 날들이 쌓이면 훅 쪽을 의심할 근거가 된다.
    const health = await db.execute<{ last_event_at: string | null; silent_active_days: number }>(sql`
      with ev as (
        select max(${skillInvocations.ts}) as t from ${skillInvocations}
        union all select max(${gateEvents.ts}) from ${gateEvents}
      ),
      last_ev as (select max(t) as t from ev)
      select
        (select t from last_ev) as last_event_at,
        coalesce((
          select count(distinct ${turns.ts}::date)::int from ${turns}
          where ${turns.ts}::date > (select t from last_ev)::date
        ), 0) as silent_active_days
    `)
    const h = health.rows[0]
    const silentActiveDays = Number(h?.silent_active_days ?? 0)

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
          silenceActiveDays: silenceDays,
          medianGapActiveDays: medianGapDays,
        }
      })
      // 죽은 것 먼저, 같은 상태 안에서는 오래 조용한 것 먼저.
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.silenceActiveDays - a.silenceActiveDays,
      )

    return {
      thresholds: {
        minEvents: MIN_EVENTS,
        deadMultiplier: DEAD_MULTIPLIER,
        quietMultiplier: QUIET_MULTIPLIER,
        deadFloorDays: DEAD_FLOOR_DAYS,
        harnessSilentDays: HARNESS_SILENT_DAYS,
      },
      harness: {
        lastEventAt: h?.last_event_at ?? null,
        silentActiveDays,
        alarm: silentActiveDays >= HARNESS_SILENT_DAYS,
      },
      rules,
    }
  })
}
