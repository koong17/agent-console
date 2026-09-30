import { Type } from 'typebox'
import { sql } from 'drizzle-orm'
import type { App } from './app.js'
import { DateTime } from './schemas.js'
import { db } from './db/index.js'
import { correctionReplays, decisionKinds, decisionPolicies, decisions, messageIntents, messages, shadowPredictions, skillInvocations, toolResults } from './db/schema.js'
import { strip } from './jobs/shadow-predict.js'

// 대체 로드맵의 점수판(/scoreboard). 브레인이 수아를 얼마나 대신하고 있나를 숫자로 본다.
//
// 첫 항목은 "수아 분": 에이전트가 수아를 기다리게 만든 시간. 두 갈래로 잰다.
//   reply    에이전트가 말을 멈춘 뒤(글) 수아가 다음 메시지를 치기까지. messages.replyTo 로 짝을 짓는다.
//   question 에이전트가 질문(AskUserQuestion)을 띄운 뒤 수아가 답하기까지. tool_results 의 ts - calledAt.
//
// 합계가 아니라 중앙값과 p90 을 낸다. 수아가 점심을 먹으러 가면 한 간격이 몇 시간이 된다.
// 합계는 그런 간격 몇 개가 전부를 차지해서 "기다리게 한 시간"이 아니라 "자리를 비운 시간"이 된다.
// 몇 분 넘으면 자리 비움으로 치는 식의 잘라내기 기준은 근거가 없어서 두지 않았다.
// 중앙값은 그런 간격에 흔들리지 않고, p90 은 그 꼬리가 얼마나 긴지를 따로 보여준다.
//
// reply 쪽의 한계: 에이전트가 말을 멈춘 시각을 "마지막 글 블록의 시각"으로 본다. 글을 쓴 뒤
// 도구를 더 부르고 끝난 턴이면 실제 멈춘 시각보다 이르게 잡혀 간격이 길어진다.

const DAYS = 30

const INTENTS = ['correction', 'answer', 'redirect', 'approval', 'new-request', 'other'] as const
const IntentCounts = Type.Object(Object.fromEntries(INTENTS.map((i) => [i, Type.Integer()])) as Record<(typeof INTENTS)[number], ReturnType<typeof Type.Integer>>)

const Interventions = Type.Object({
  days: Type.Integer(),
  // 분류가 끝난 메시지 / 전체 typed 메시지. 분류가 덜 됐으면 아래 비율은 일부로만 낸 값이다.
  classified: Type.Integer(),
  typed: Type.Integer(),
  total: Type.Object({ activeHours: Type.Integer(), counts: IntentCounts }),
  byDay: Type.Array(Type.Object({ day: Type.String(), activeHours: Type.Integer(), counts: IntentCounts })),
})

const Corrections = Type.Object({
  total: Type.Integer({ description: '교정으로 분류된 메시지 수' }),
  replayed: Type.Integer({ description: '그중 되짚기가 끝난 수' }),
  byCause: Type.Object({
    missing: Type.Integer(),
    ignored: Type.Integer(),
    wrong: Type.Integer(),
    'not-judgment': Type.Integer(),
  }),
  // ignored/wrong 에서 가리킨 규칙. 많이 나오는 규칙이 가장 먼저 손볼 곳이다.
  byRule: Type.Array(Type.Object({ rule: Type.String(), ignored: Type.Integer(), wrong: Type.Integer() })),
  recent: Type.Array(
    Type.Object({
      messageId: Type.String(),
      ts: DateTime,
      text: Type.String(),
      cause: Type.String(),
      rule: Type.Union([Type.String(), Type.Null()]),
      inboxDraft: Type.Union([Type.String(), Type.Null()]),
      reason: Type.String(),
    }),
  ),
})
// 되짚은 교정 목록 길이. inbox 초안을 고르는 자리라 한 번에 읽을 만큼만.
const RECENT_CORRECTIONS = 30

// 케이스 × 모드의 최신 결과. 실행마다 --filter 로 고른 케이스가 달라서 "실행별 통과율"은
// 서로 비교가 안 된다. 케이스마다 모드별 최신 결과를 모아 케이스 단위로 판정한다.
const EvalCase = Type.Object({
  model: Type.String(),
  caseId: Type.String(),
  rules: Type.Array(Type.String()),
  full: Type.Union([Type.Boolean(), Type.Null()]),
  baseline: Type.Union([Type.Boolean(), Type.Null()]),
  holdout: Type.Union([Type.Boolean(), Type.Null()]),
  lastRunAt: DateTime,
})
const Evals = Type.Object({
  models: Type.Array(
    Type.Object({
      model: Type.String(),
      cases: Type.Integer(),
      fullPass: Type.Integer(),
      // full 과 baseline 둘 다 결과가 있는 케이스 중에서
      paired: Type.Integer(),
      brainEffect: Type.Integer({ description: 'full 통과 + baseline 실패' }),
      notTesting: Type.Integer({ description: 'baseline 통과 — 브레인 없이도 맞힘' }),
      // full 과 holdout 둘 다 있는 케이스 중에서
      heldOut: Type.Integer(),
      isolated: Type.Integer({ description: 'full 통과 + holdout 실패 — 그 규칙 줄에만 적힌 판례' }),
    }),
  ),
  cases: Type.Array(EvalCase),
})

// 단계별 개입률. "단계"는 그 메시지 전에 같은 세션에서 마지막으로 불린 스킬이다.
// 스킬이 워크플로 단계를 대신한다(feature-plan → 계획, code-review → 리뷰 ...). 스킬 없이 시작한
// 대화는 '(none)' 이다. 개입률이 가장 낮은 단계가 가장 먼저 에이전트에게 맡길 후보다.
const Phases = Type.Object({
  // 표본이 이보다 적은 단계는 비율이 흔들려서 판단에 쓰지 말라는 표시만 한다(목록에서 빼지는 않는다).
  minMessages: Type.Integer(),
  phases: Type.Array(
    Type.Object({
      phase: Type.String(),
      messages: Type.Integer(),
      correction: Type.Integer(),
      redirect: Type.Integer(),
    }),
  ),
})
const PHASE_MIN_MESSAGES = 20

// 드리프트: 같은 질문 종류에서 수아의 답 정책이 시간이 지나며 바뀌었나.
// 결정을 시간순으로 반으로 나눠, 앞쪽과 뒤쪽에서 가장 많이 나온 정책을 비교한다.
// 반씩 나누는 이유: 기준 날짜를 정하면 종류마다 결정이 몰린 시기가 달라 한쪽이 비기 쉽다.
// 한계: 결정이 4~5개면 반쪽이 두세 개라, 한 번 다르게 답한 것도 드리프트로 보인다. 그래서 개수를 같이 낸다.
const DRIFT_MIN = 4
const Drift = Type.Object({
  minDecisions: Type.Integer(),
  kinds: Type.Array(
    Type.Object({
      kind: Type.String(),
      n: Type.Integer(),
      early: Type.String(),
      earlyCount: Type.Integer(),
      late: Type.String(),
      lateCount: Type.Integer(),
      drifted: Type.Boolean(),
      firstAt: DateTime,
      lastAt: DateTime,
    }),
  ),
})

const CALIBRATION_BUCKETS = 5
// 틀린 예측 목록의 길이. 읽을 것이지 훑을 것이 아니라서 짧게.
const MISSES = 30

const Shadow = Type.Object({
  n: Type.Integer({ description: '재예측이 끝난 결정 수' }),
  correct: Type.Integer({ description: '브레인이 추천 없이 수아의 답을 맞힌 수' }),
  anchored: Type.Object({
    n: Type.Integer({ description: '그중 에이전트 추천이 있던 결정 수' }),
    suahChoseRecommended: Type.Integer({ description: '수아가 추천을 고른 수 — 지금 쓰는 닻 내린 점수' }),
    brainPickedRecommended: Type.Integer({ description: '브레인의 블라인드 답이 그때의 추천과 같은 수' }),
  }),
  calibration: Type.Array(
    Type.Object({
      from: Type.Number(),
      to: Type.Number(),
      n: Type.Integer(),
      correct: Type.Integer(),
      meanConfidence: Type.Number(),
    }),
  ),
  byKind: Type.Array(Type.Object({ kind: Type.String(), n: Type.Integer(), correct: Type.Integer() })),
  misses: Type.Array(
    Type.Object({
      decisionId: Type.Integer(),
      ts: DateTime,
      question: Type.String(),
      predicted: Type.String(),
      chosen: Type.String(),
      confidence: Type.Number(),
      reason: Type.String(),
      kind: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
})

const Latency = Type.Object({
  n: Type.Integer(),
  // 초. n 이 0 이면 null.
  p50: Type.Union([Type.Number(), Type.Null()]),
  p90: Type.Union([Type.Number(), Type.Null()]),
})

const Minutes = Type.Object({
  days: Type.Integer(),
  total: Type.Object({ reply: Latency, question: Latency }),
  // 최근 날짜부터. 기록이 있는 날만.
  byDay: Type.Array(Type.Object({ day: Type.String(), reply: Latency, question: Latency })),
})

type Row = { day: string | null; kind: 'reply' | 'question'; n: number; p50: number | null; p90: number | null }

export function scoreboardRoutes(app: App) {
  app.get('/scoreboard/minutes', { schema: { response: { 200: Minutes } } }, async () => {
    // 두 갈래를 한 목록(gaps)으로 합친 뒤 날짜별·전체를 grouping sets 로 한 번에 낸다.
    // grouping sets ((day, kind), (kind)) 는 GROUP BY 두 번을 한 문장으로 한 것이다.
    // 두 번째 묶음에서는 day 가 null 로 나오고, 그게 "전체" 줄이다.
    const result = await db.execute<Row>(sql`
      with gaps as (
        select 'reply' as kind, m.ts, extract(epoch from m.ts - a.ts) as s
        from ${messages} m join ${messages} a on a.id = m.reply_to
        where m.kind = 'typed' and m.ts >= a.ts
        union all
        select 'question', ${toolResults.ts}, extract(epoch from ${toolResults.ts} - ${toolResults.calledAt})
        from ${toolResults}
        where ${toolResults.tool} = 'AskUserQuestion' and ${toolResults.calledAt} is not null
          and ${toolResults.ts} >= ${toolResults.calledAt}
      )
      select
        to_char(ts::date, 'YYYY-MM-DD') as day, kind, count(*)::int as n,
        percentile_cont(0.5) within group (order by s) as p50,
        percentile_cont(0.9) within group (order by s) as p90
      from gaps
      where ts > now() - make_interval(days => ${DAYS})
      group by grouping sets ((ts::date, kind), (kind))
    `)

    type L = { n: number; p50: number | null; p90: number | null }
    const empty = (): L => ({ n: 0, p50: null, p90: null })
    const pick = (r: Row): L => ({ n: Number(r.n), p50: r.p50 === null ? null : Number(r.p50), p90: r.p90 === null ? null : Number(r.p90) })
    const total = { reply: empty(), question: empty() }
    const days = new Map<string, { day: string; reply: L; question: L }>()
    for (const r of result.rows) {
      if (r.day === null) {
        total[r.kind] = pick(r)
        continue
      }
      const d = days.get(r.day) ?? { day: r.day, reply: empty(), question: empty() }
      d[r.kind] = pick(r)
      days.set(r.day, d)
    }
    return { days: DAYS, total, byDay: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)) }
  })

  // 블라인드 재예측 점수. shadow_predictions 는 pnpm jobs shadow-predict 가 채운다.
  app.get('/scoreboard/shadow', { schema: { response: { 200: Shadow } } }, async () => {
    const rows = await db
      .select({
        decisionId: decisions.id,
        ts: decisions.ts,
        question: decisions.question,
        recommended: decisions.recommended,
        chosen: decisions.chosen,
        predicted: shadowPredictions.predicted,
        confidence: shadowPredictions.confidence,
        correct: shadowPredictions.correct,
        reason: shadowPredictions.reason,
        kind: decisionKinds.kind,
      })
      .from(shadowPredictions)
      .innerJoin(decisions, sql`${decisions.id} = ${shadowPredictions.decisionId}`)
      .leftJoin(decisionKinds, sql`${decisionKinds.decisionId} = ${shadowPredictions.decisionId}`)
      .orderBy(sql`${decisions.ts} desc`)

    // 같은 결정들에서 "수아가 추천을 골랐나"(닻 내린 점수)와 나란히 놓는다.
    // 추천이 없던 결정은 그 비교에서만 빠진다.
    const withRec = rows.filter((r) => r.recommended !== null)
    const recMatch = withRec.filter((r) => strip(r.recommended!) === strip(r.chosen!)).length
    const brainAgreesRec = withRec.filter((r) => strip(r.recommended!) === r.predicted).length

    // 보정: 확신을 다섯 칸으로 나눠, 칸마다 실제 정답률을 본다. 잘 보정됐으면 0.8 칸의 정답률이 0.8 근처다.
    // 칸 경계는 [0,0.2) [0.2,0.4) ... [0.8,1.0]. 1.0 은 마지막 칸에 넣는다.
    const buckets = Array.from({ length: CALIBRATION_BUCKETS }, (_, i) => ({
      from: i / CALIBRATION_BUCKETS,
      to: (i + 1) / CALIBRATION_BUCKETS,
      n: 0,
      correct: 0,
      meanConfidence: 0,
    }))
    for (const r of rows) {
      const c = Number(r.confidence)
      const b = buckets[Math.min(CALIBRATION_BUCKETS - 1, Math.floor(c * CALIBRATION_BUCKETS))]!
      b.n++
      b.meanConfidence += c
      if (r.correct) b.correct++
    }
    for (const b of buckets) if (b.n) b.meanConfidence /= b.n

    // 질문 종류별. 어디서 브레인이 틀리는지가 다음에 고칠 규칙을 가리킨다.
    const kinds = new Map<string, { kind: string; n: number; correct: number }>()
    for (const r of rows) {
      const k = r.kind ?? '(분류 전)'
      const e = kinds.get(k) ?? { kind: k, n: 0, correct: 0 }
      e.n++
      if (r.correct) e.correct++
      kinds.set(k, e)
    }

    return {
      n: rows.length,
      correct: rows.filter((r) => r.correct).length,
      anchored: { n: withRec.length, suahChoseRecommended: recMatch, brainPickedRecommended: brainAgreesRec },
      calibration: buckets,
      byKind: [...kinds.values()].sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind)),
      misses: rows
        .filter((r) => !r.correct)
        .slice(0, MISSES)
        .map((r) => ({
          decisionId: r.decisionId,
          ts: r.ts,
          question: r.question,
          predicted: r.predicted,
          chosen: strip(r.chosen!),
          confidence: Number(r.confidence),
          reason: r.reason,
          kind: r.kind,
        })),
    }
  })

  // 개입. 북극성은 활동 시간당 교정 수다.
  //
  // "세션 시간"이 아니라 "활동 시간"인 이유: 세션은 며칠씩 열려 있고(재개), 시작~마지막 줄 사이의
  // 대부분은 자리를 비운 시간이다. 수아가 메시지를 한 번이라도 친 시(hour)만 센다. 한 시간 안에
  // 메시지 하나를 쳐도 한 시간이라 짧게 들른 날이 과대평가되지만, 기준이 날마다 같아서 추세 비교는 된다.
  app.get('/scoreboard/interventions', { schema: { response: { 200: Interventions } } }, async () => {
    const result = await db.execute<{ day: string | null; intent: string | null; n: number }>(sql`
      with typed as (
        select m.ts, mi.intent from ${messages} m
        left join ${messageIntents} mi on mi.message_id = m.id
        where m.kind = 'typed' and m.ts > now() - make_interval(days => ${DAYS})
      )
      select to_char(ts::date, 'YYYY-MM-DD') as day, intent, count(*)::int as n
      from typed
      group by grouping sets ((ts::date, intent), (intent))
    `)
    // 활동 시간은 분류와 무관하게 센다. 위 문장에 끼우면 intent 별 줄마다 같은 값이 반복된다.
    const hours = await db.execute<{ day: string | null; hours: number }>(sql`
      select to_char(ts::date, 'YYYY-MM-DD') as day, count(distinct date_trunc('hour', ts))::int as hours
      from ${messages}
      where kind = 'typed' and ts > now() - make_interval(days => ${DAYS})
      group by grouping sets ((ts::date), ())
    `)
    const zero = () => Object.fromEntries(INTENTS.map((i) => [i, 0])) as Record<(typeof INTENTS)[number], number>
    const total = { activeHours: 0, counts: zero() }
    const days = new Map<string, { day: string; activeHours: number; counts: ReturnType<typeof zero> }>()
    for (const h of hours.rows) {
      if (h.day === null) total.activeHours = Number(h.hours)
      else days.set(h.day, { day: h.day, activeHours: Number(h.hours), counts: zero() })
    }
    let classified = 0
    let typed = 0
    for (const r of result.rows) {
      const n = Number(r.n)
      if (r.day === null) {
        typed += n
        if (r.intent) classified += n
      }
      if (!r.intent) continue
      const target = r.day === null ? total : days.get(r.day)
      if (target) target.counts[r.intent as (typeof INTENTS)[number]] = n
    }
    return {
      days: DAYS,
      classified,
      typed,
      total,
      byDay: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    }
  })

  // 교정 되짚기. pnpm jobs correction-replay 가 채운다(message-intent 가 먼저 돌아야 대상이 생긴다).
  app.get('/scoreboard/corrections', { schema: { response: { 200: Corrections } } }, async () => {
    const [agg] = await db
      .select({
        total: sql<number>`count(*)::int`,
        replayed: sql<number>`count(${correctionReplays.messageId})::int`,
        missing: sql<number>`count(*) filter (where ${correctionReplays.cause} = 'missing')::int`,
        ignored: sql<number>`count(*) filter (where ${correctionReplays.cause} = 'ignored')::int`,
        wrong: sql<number>`count(*) filter (where ${correctionReplays.cause} = 'wrong')::int`,
        notJudgment: sql<number>`count(*) filter (where ${correctionReplays.cause} = 'not-judgment')::int`,
      })
      .from(messageIntents)
      .leftJoin(correctionReplays, sql`${correctionReplays.messageId} = ${messageIntents.messageId}`)
      .where(sql`${messageIntents.intent} = 'correction'`)
    const byRule = await db
      .select({
        rule: sql<string>`${correctionReplays.rule}`,
        ignored: sql<number>`count(*) filter (where ${correctionReplays.cause} = 'ignored')::int`,
        wrong: sql<number>`count(*) filter (where ${correctionReplays.cause} = 'wrong')::int`,
      })
      .from(correctionReplays)
      .where(sql`${correctionReplays.rule} is not null`)
      .groupBy(correctionReplays.rule)
      .orderBy(sql`count(*) desc`)
    const recent = await db
      .select({
        messageId: correctionReplays.messageId,
        ts: messages.ts,
        text: messages.text,
        cause: correctionReplays.cause,
        rule: correctionReplays.rule,
        inboxDraft: correctionReplays.inboxDraft,
        reason: correctionReplays.reason,
      })
      .from(correctionReplays)
      .innerJoin(messages, sql`${messages.id} = ${correctionReplays.messageId}`)
      .orderBy(sql`${messages.ts} desc`)
      .limit(RECENT_CORRECTIONS)
    return {
      total: Number(agg?.total ?? 0),
      replayed: Number(agg?.replayed ?? 0),
      byCause: {
        missing: Number(agg?.missing ?? 0),
        ignored: Number(agg?.ignored ?? 0),
        wrong: Number(agg?.wrong ?? 0),
        'not-judgment': Number(agg?.notJudgment ?? 0),
      },
      byRule: byRule.map((r) => ({ rule: r.rule, ignored: Number(r.ignored), wrong: Number(r.wrong) })),
      // 긴 붙여넣기가 표를 덮지 않게 앞부분만. 전문은 세션 화면에 있다.
      recent: recent.map((r) => ({ ...r, text: r.text.slice(0, 300) })),
    }
  })

  // 브레인 평가. suah-brain/evals/results 를 적재한 eval_runs/eval_results 에서.
  app.get('/scoreboard/evals', { schema: { response: { 200: Evals } } }, async () => {
    // distinct on 은 Postgres 전용 문법이다. (model, case, mode) 마다 order by 의 첫 줄, 즉 최신 하나만 남긴다.
    const latest = await db.execute<{ model: string; case_id: string; mode: string; pass: boolean; rules: string[]; ran_at: string }>(sql`
      select distinct on (r.model, e.case_id, r.mode) r.model, e.case_id, r.mode, e.pass, e.rules, r.ran_at
      from eval_results e join eval_runs r on r.file = e.run_file
      order by r.model, e.case_id, r.mode, r.ran_at desc
    `)
    const cases = new Map<string, { model: string; caseId: string; rules: string[]; full: boolean | null; baseline: boolean | null; holdout: boolean | null; lastRunAt: string }>()
    for (const r of latest.rows) {
      const key = `${r.model}\u0000${r.case_id}`
      const c = cases.get(key) ?? { model: r.model, caseId: r.case_id, rules: r.rules, full: null, baseline: null, holdout: null, lastRunAt: r.ran_at }
      c[r.mode as 'full' | 'baseline' | 'holdout'] = r.pass
      if (r.ran_at > c.lastRunAt) c.lastRunAt = r.ran_at
      cases.set(key, c)
    }
    const all = [...cases.values()]
    const models = [...new Set(all.map((c) => c.model))].map((model) => {
      const cs = all.filter((c) => c.model === model)
      const paired = cs.filter((c) => c.full !== null && c.baseline !== null)
      const held = cs.filter((c) => c.full !== null && c.holdout !== null)
      return {
        model,
        cases: cs.length,
        fullPass: cs.filter((c) => c.full === true).length,
        paired: paired.length,
        brainEffect: paired.filter((c) => c.full && !c.baseline).length,
        notTesting: paired.filter((c) => c.baseline).length,
        heldOut: held.length,
        isolated: held.filter((c) => c.full && !c.holdout).length,
      }
    })
    return { models, cases: all.sort((a, b) => a.caseId.localeCompare(b.caseId)) }
  })

  app.get('/scoreboard/phases', { schema: { response: { 200: Phases } } }, async () => {
    // lateral 은 "바깥 행마다 한 번씩 도는 서브쿼리"다. 메시지마다 그 전의 마지막 스킬 하나를 찾는다.
    // 인덱스(skill_invocations 는 skill, ts)가 session 기준이 아니라 느릴 수 있다 — 메시지가 수천 개라 지금은 괜찮다.
    const result = await db.execute<{ phase: string; messages: number; correction: number; redirect: number }>(sql`
      select coalesce(p.skill, '(none)') as phase,
        count(*)::int as messages,
        count(*) filter (where mi.intent = 'correction')::int as correction,
        count(*) filter (where mi.intent = 'redirect')::int as redirect
      from ${messages} m
      join ${messageIntents} mi on mi.message_id = m.id
      left join lateral (
        select ${skillInvocations.skill} as skill from ${skillInvocations}
        where ${skillInvocations.sessionId} = m.session_id and ${skillInvocations.ts} <= m.ts
        order by ${skillInvocations.ts} desc limit 1
      ) p on true
      where m.kind = 'typed'
      group by 1
      order by 2 desc
    `)
    return {
      minMessages: PHASE_MIN_MESSAGES,
      phases: result.rows.map((r) => ({ phase: r.phase, messages: Number(r.messages), correction: Number(r.correction), redirect: Number(r.redirect) })),
    }
  })

  app.get('/scoreboard/drift', { schema: { response: { 200: Drift } } }, async () => {
    const rows = await db
      .select({ kind: decisionPolicies.kind, policy: decisionPolicies.policy, ts: decisions.ts })
      .from(decisionPolicies)
      .innerJoin(decisions, sql`${decisions.id} = ${decisionPolicies.decisionId}`)
      .orderBy(sql`${decisionPolicies.kind}, ${decisions.ts}`)
    const byKind = new Map<string, Array<{ policy: string; ts: Date }>>()
    for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), { policy: r.policy, ts: r.ts }])
    // 가장 많이 나온 정책. 동점이면 더 나중에 나온 쪽 — 최근 판단을 앞세운다.
    const mode = (xs: string[]) => {
      const c = new Map<string, number>()
      xs.forEach((x) => c.set(x, (c.get(x) ?? 0) + 1))
      let best = xs.at(-1)!
      for (const [k, v] of c) if (v > c.get(best)! || (v === c.get(best)! && xs.lastIndexOf(k) > xs.lastIndexOf(best))) best = k
      return { policy: best, count: c.get(best)! }
    }
    const kinds = [...byKind]
      .filter(([, xs]) => xs.length >= DRIFT_MIN)
      .map(([kind, xs]) => {
        const half = Math.floor(xs.length / 2)
        const early = mode(xs.slice(0, half).map((x) => x.policy))
        const late = mode(xs.slice(half).map((x) => x.policy))
        return {
          kind,
          n: xs.length,
          early: early.policy,
          earlyCount: early.count,
          late: late.policy,
          lateCount: late.count,
          drifted: early.policy !== late.policy,
          firstAt: xs[0]!.ts,
          lastAt: xs.at(-1)!.ts,
        }
      })
      .sort((a, b) => Number(b.drifted) - Number(a.drifted) || b.n - a.n)
    return { minDecisions: DRIFT_MIN, kinds }
  })
}
