import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

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
    // true면 서브에이전트(Agent 도구로 띄운 별도 대화)의 응답. transcript의 isSidechain.
    // 서브에이전트 파일은 projects/<cwd>/<session>/subagents/**/*.jsonl 에 따로 있고 sessionId는
    // 부모와 같다. 2026-09-08 발견: 이 파일들을 안 읽어 응답의 약 1/3, 비용이 그만큼 빠져 있었다.
    sidechain: boolean('sidechain').notNull().default(false),
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
    // 스킬이 불린 경로. 'tool' = 모델이 Skill 도구로 호출(PreToolUse 훅이 울림),
    // 'command' = 사용자가 "/이름" 으로 직접 입력(도구 호출이 없어 훅이 안 울림).
    // 2026-09-08 발견: command 경로는 게이트 훅을 우회한다. 둘을 나눠야 준수율이 정직해진다.
    source: text('source', { enum: ['tool', 'command'] })
      .notNull()
      .default('tool'),
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

// 에이전트가 선택지를 내밀었을 때(AskUserQuestion) Suah가 무엇을 골랐나.
// 출처는 harness-events.jsonl의 type=decision 줄(scripts/hooks/log-decision.sh가 남긴다).
// transcript는 30일 뒤 지워지므로 이 표가 그 결정의 유일한 장기 기록이다.
export const decisions = pgTable(
  'decisions',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    repo: text('repo'),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    // 도구 호출에서 질문 위에 붙는 짧은 칩 라벨("경로", "Approach"). 빈 문자열일 수 있다.
    header: text('header').notNull().default(''),
    question: text('question').notNull(),
    // 선택지 라벨 배열. 열을 나누지 않고 jsonb 하나에 두는 이유: 개수가 2~4개로 가변이고,
    // 화면은 항상 "전체를 한 줄로" 보여주기만 하며 라벨 단위로 조회하지 않는다.
    options: jsonb('options').$type<string[]>().notNull(),
    // 라벨에 "(Recommended)"/"(추천)"이 붙은 선택지. 에이전트가 추천을 안 했으면 null.
    recommended: text('recommended'),
    // 실제 고른 값. 다중 선택은 콤마로 이어진 문자열, "Other" 직접 입력은 선택지에 없는 문장.
    chosen: text('chosen'),
    // chosen == recommended. null은 "판정 불가"(추천이 없거나 답을 못 읽음)다. false("반대함")와 다르다.
    agreed: boolean('agreed'),
    // chosen을 못 읽었을 때만 응답 원문. 응답 형식이 바뀌었는지 나중에 추적하는 용도.
    rawResponse: jsonb('raw_response'),
  },
  // 훅은 초 단위 ts를 남긴다. 한 번의 호출에 질문이 여럿이면 ts가 같으므로 question까지 키에 넣는다.
  // 같은 세션이 같은 초에 같은 문장을 두 번 묻는 일은 없다.
  (t) => [uniqueIndex('decisions_natural_key').on(t.sessionId, t.ts, t.question)],
)

export type Session = typeof sessions.$inferSelect
export type Turn = typeof turns.$inferSelect
export type SkillInvocation = typeof skillInvocations.$inferSelect
export type GateEvent = typeof gateEvents.$inferSelect
export type Decision = typeof decisions.$inferSelect

// ---------------------------------------------------------------------------
// 모델 단가 (USD / 100만 토큰). 출처: platform.claude.com/docs/en/about-claude/pricing
// 코드가 아니라 표에 두는 이유: 비용을 SQL에서 SUM(토큰 × 단가) 한 줄로 내기 위해서다.
// 단가가 바뀌면 행을 UPDATE 한다. 초기값은 pnpm db:seed 로 넣는다.
// ---------------------------------------------------------------------------
export const modelPrices = pgTable('model_prices', {
  model: text('model').primaryKey(),
  inputUsd: numeric('input_usd', { precision: 8, scale: 4 }).notNull(),
  cacheWrite5mUsd: numeric('cache_write_5m_usd', { precision: 8, scale: 4 }).notNull(),
  cacheWrite1hUsd: numeric('cache_write_1h_usd', { precision: 8, scale: 4 }).notNull(),
  cacheReadUsd: numeric('cache_read_usd', { precision: 8, scale: 4 }).notNull(),
  outputUsd: numeric('output_usd', { precision: 8, scale: 4 }).notNull(),
  // 확인한 날. 단가 표가 오래됐는지 화면에서 판단하는 근거.
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
})

export type ModelPrice = typeof modelPrices.$inferSelect

// ---------------------------------------------------------------------------
// ingestion 실행 기록. 스케줄러 상태가 메모리에만 있으면 재시작 때 "마지막 성공이 언제였나"가
// 사라진다. 실행 하나당 한 줄. 시작할 때 running으로 넣고 끝나면 같은 줄을 갱신한다.
// ---------------------------------------------------------------------------
// 파서 자기 진단 카운터.
//
// 왜 필요한가: 지금까지 실행 기록에 남는 건 "넣은 행 수"뿐이다. turns=0 은 세 가지
// 서로 다른 상황에서 똑같이 0으로 보인다.
//   (1) 그 사이 아무 일도 없었다        — 정상
//   (2) 읽은 줄이 전부 이미 들어가 있다  — 정상
//   (3) 파서가 줄을 못 알아본다          — 고장
// (3)은 우리가 코드를 바꿔서가 아니라 Claude Code가 로그 형식을 바꿔서 생긴다.
// 구분하려면 "읽은 줄"과 "알아본 줄"을 따로 세야 한다.
//
// 카운터는 두 부류로 나눈다. 예상된 탈락(synthetic 응답, 설계상 안 넣는 skill 줄)은
// 0이 아닌 게 정상이고, 설명 안 되는 탈락(badJson, unusable, unknownType, incomplete)은
// 0이어야 정상이다. 화면에는 뒤쪽 합만 내보낸다.
// 고장에는 두 모양이 있고, 카운터도 두 모양이 필요하다.
//
//   A형: 줄은 알아봤는데 못 쓴다. "assistant 줄 맞는데 usage 가 없다."
//        → unusable, incomplete, badJson 이 잡는다.
//   B형: 줄이 아예 우리 필터에 안 걸린다. 상류가 type 이름을 바꾸면 모든 줄이
//        "관심사 아님"으로 조용히 빠지고, 화면은 조용한 시간과 똑같아 보인다.
//        → typeCounts + unknownTypeLines 가 잡는다.
//
// B형이 더 흔하다. 상류가 실제로 하는 변경은 대개 필드나 타입 "이름" 바꾸기다.
export type TranscriptStats = {
  lines: number // 읽은 줄 전체
  badJson: number // JSON.parse 실패 (설명 안 됨)
  filesEmpty: number // 세션을 하나도 못 알아본 파일 (설명 안 됨)
  // type 별 줄 수 전체. 아는 타입까지 다 담는다. 경보와 별개로,
  // "그날 assistant 가 0이고 response 가 201이었다"를 나중에 눈으로 확인하는 기록.
  typeCounts: Record<string, number>
  unknownTypeLines: number // 아는 타입 목록에 없는 줄 (설명 안 됨)
  assistantLines: number // type=assistant 이고 message 가 있는 줄 = turn 후보
  synthetic: number // model='<synthetic>' 이라 뺀 줄 (예상됨)
  unusable: number // assistant 인데 id/usage/model 이 없는 줄 (설명 안 됨)
}

export type EventStats = {
  lines: number
  badJson: number // (설명 안 됨)
  skillLines: number // type=skill. 설계상 안 넣는다 (예상됨)
  unknownType: number // 우리가 모르는 type (설명 안 됨)
  incomplete: number // 아는 type 인데 필수 필드가 없다 (설명 안 됨)
}

export type IngestStats = { transcripts: TranscriptStats; events: EventStats }

export const ingestRuns = pgTable('ingest_runs', {
  id: serial('id').primaryKey(),
  trigger: text('trigger', { enum: ['startup', 'interval', 'manual'] }).notNull(),
  status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  files: integer('files'),
  turns: integer('turns'),
  // 이미 있던 행의 토큰이 더 큰 값으로 교정된 수. 정상 실행에서는 0이다.
  // 0이 아니면 "전에 잘못 넣었던 값을 이번에 고쳤다"는 뜻이라 삽입 수와 섞으면 안 된다.
  turnsUpdated: integer('turns_updated'),
  skills: integer('skills'),
  gates: integer('gates'),
  decisions: integer('decisions'),
  // 열을 열한 개 더 늘리지 않고 jsonb 하나에 둔다. 어떤 카운터가 실제로 드리프트를
  // 잡아내는지 아직 모르고, 카운터가 바뀔 때마다 스키마를 흔들고 싶지 않다.
  // 대신 API 응답 스키마(scheduler.ts)에서 필드 이름을 전부 못박아 계약은 유지한다.
  stats: jsonb('stats').$type<IngestStats>(),
  error: text('error'),
})

export type IngestRun = typeof ingestRuns.$inferSelect
