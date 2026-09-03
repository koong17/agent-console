import { pgTable, serial, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// 자기 관찰: 이 서버가 받은 HTTP 요청
// ---------------------------------------------------------------------------

// 링 버퍼 시절의 Trace 형태를 그대로 테이블로 옮겼다.
// id는 DB가 매기는 serial이다. Fastify의 req.id("req-1", "req-2"...)는
// 프로세스 재시작마다 1부터 다시 시작해서 영구 저장소의 키로는 못 쓴다.
export const traces = pgTable('traces', {
  id: serial('id').primaryKey(),
  requestId: text('request_id').notNull(),
  method: text('method').notNull(),
  url: text('url').notNull(),
  statusCode: integer('status_code').notNull(),
  durationMs: integer('duration_ms').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
})

export type Trace = typeof traces.$inferSelect
export type NewTrace = typeof traces.$inferInsert

// ---------------------------------------------------------------------------
// 하네스 데이터: Claude Code 세션에서 일어난 일
//
// 출처는 ~/.claude/projects/<cwd>/<session>.jsonl (transcript)과
// ~/.claude/harness-events.jsonl (훅이 남기는 스킬/게이트 이벤트).
// 원본 파일의 한 줄이 곧 한 행이 되도록 설계했다. 그래야 같은 파일을 다시 읽어도
// 고유 키 충돌로 중복이 걸러진다 (milestone 3의 멱등 ingestion 기반).
// ---------------------------------------------------------------------------

// 세션 하나당 한 줄. PK는 Claude Code가 부여한 세션 UUID 그대로.
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  cwd: text('cwd').notNull(),
  // cwd의 마지막 폴더명. "레포별" 집계에 매번 문자열을 자르지 않도록 저장 시점에 뽑아둔다.
  repo: text('repo').notNull(),
  gitBranch: text('git_branch'),
  cliVersion: text('cli_version'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  // transcript의 마지막 줄 시각. 세션은 "끝" 이벤트가 없어서 이걸로 대신한다.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
})

// 어시스턴트 응답 하나당 한 줄. 토큰 사용량은 여기에만 있다.
// 세션별 비용은 이 표를 합산해서 구한다. 합계를 sessions에 미리 넣지 않는 이유:
// 한 세션 안에서 모델이 바뀌면 합계 하나로는 비용을 계산할 수 없다.
export const turns = pgTable(
  'turns',
  {
    // API 응답의 message.id ("msg_..."). transcript는 응답 하나를 콘텐츠 블록마다
    // 한 줄씩 쪼개 저장하고(텍스트 줄, 도구 호출 줄...) 각 줄이 같은 usage를 반복한다.
    // 줄 uuid를 키로 쓰면 토큰이 두세 배로 잡힌다. message.id가 "응답 하나"의 단위다.
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheCreationTokens: integer('cache_creation_tokens').notNull(),
    // 캐시 쓰기는 5분짜리와 1시간짜리 단가가 다르다(1.25x vs 2x). 위 합계 중 1시간 분량만
    // 따로 둔다. 5분 분량 = 합계 - 1시간. Claude Code는 1시간 캐시를 쓴다.
    cacheCreation1hTokens: integer('cache_creation_1h_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull(),
  },
  (t) => [index('turns_session_ts_idx').on(t.sessionId, t.ts)],
)

// 스킬 호출 하나당 한 줄.
export const skillInvocations = pgTable(
  'skill_invocations',
  {
    // transcript의 tool_use id ("toolu_..."). 옛 skill-usage.log 백필은
    // 세션이 없으므로 "legacy:<epoch>:<n>" 형태의 합성 키를 쓴다.
    id: text('id').primaryKey(),
    // 백필 행은 세션을 모르므로 null 허용. 그래서 FK를 걸지 않는다.
    sessionId: text('session_id'),
    repo: text('repo'),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    skill: text('skill').notNull(),
    args: text('args').notNull().default(''),
  },
  (t) => [index('skill_invocations_skill_ts_idx').on(t.skill, t.ts)],
)

// suah-judge 게이트가 울린 기록. 출처는 harness-events.jsonl의 type=gate 줄.
// outcome: 'nudged'(안내 문구를 실제로 주입) | 'throttled'(TTL 안이라 조용히 통과)
export const gateEvents = pgTable(
  'gate_events',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    repo: text('repo'),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    // 게이트를 건드린 스킬 (code-review, feature-plan ...)
    triggerSkill: text('trigger_skill').notNull(),
    outcome: text('outcome', { enum: ['nudged', 'throttled'] }).notNull(),
  },
  // 훅은 초 단위 ts를 남기고, 같은 초에 같은 세션이 같은 스킬을 두 번 부르는 일은 없다.
  // 이 조합이 자연 키라서 다시 읽어도 중복이 안 들어간다.
  (t) => [uniqueIndex('gate_events_natural_key').on(t.sessionId, t.ts, t.triggerSkill)],
)

export type Session = typeof sessions.$inferSelect
export type Turn = typeof turns.$inferSelect
export type SkillInvocation = typeof skillInvocations.$inferSelect
export type GateEvent = typeof gateEvents.$inferSelect
