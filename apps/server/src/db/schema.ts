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

// 도구 응답 하나당 한 줄. 컨텍스트가 어디서 커졌는지 이름을 붙이는 표다.
//
// 세션 상세의 컨텍스트 곡선은 "여기서 뛰었다"까지만 말한다. 무엇 때문인지는 못 말한다.
// 도구 응답은 한 번 들어오면 대화가 끝날 때까지 컨텍스트에 남고, 남은 턴 수만큼
// 캐시 읽기로 다시 계산된다. 그래서 큰 응답 하나의 비용은 그 크기 × 남은 턴 수다.
//
// 크기는 바이트다. 토큰이 아니다. 이미지(base64)와 텍스트는 바이트당 토큰 수가 다르므로
// 바이트끼리만 비교하고, 토큰 기여는 앞뒤 턴의 컨텍스트 차이로 따로 봐야 한다.
// 2026-09-29 측정: 26,487건 115MB, 40KB 넘는 응답 411건.
export const toolResults = pgTable(
  'tool_results',
  {
    // transcript 의 tool_use id. 도구 호출 하나에 응답 하나라 그대로 기본 키가 된다.
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    repo: text('repo'),
    // 응답이 돌아온 줄의 시각. 컨텍스트 곡선과 같은 시간축에 놓으려고 둔다.
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    // 도구 이름. tool_use 블록에서 가져온다 — tool_result 줄 자체에는 이름이 없다.
    tool: text('tool').notNull(),
    bytes: integer('bytes').notNull(),
  },
  // "이 세션에서 큰 것부터" 가 유일한 조회 형태다.
  (t) => [index('tool_results_session_bytes_idx').on(t.sessionId, t.bytes)],
)

// 대화 본문. 사람이 친 말과 에이전트가 글로 한 말을 한 표에 시간순으로 담는다.
//
// 왜 필요한가: 토큰·도구·결정은 이미 DB 에 있지만 "무슨 말을 했나"는 transcript 에만 있었다.
// transcript 는 설정(cleanupPeriodDays)이 바뀌면 다시 지워진다. 교정 분류, 되풀이 검증,
// 취향 측정 같은 로드맵 뒤 단계는 전부 이 본문을 재료로 쓴다.
//
// 담지 않는 것: tool_result(도구 응답 — 크기만 tool_results 에), 훅·시스템이 넣은 isMeta 줄,
// 로컬 명령 출력, 백그라운드 작업 알림, thinking 블록. 사람이 친 것도, 에이전트가 사람에게
// 보여준 글도 아니기 때문이다. AskUserQuestion 답은 tool_result 로 오므로 decisions 표가 맡는다.
//
// "직전 에이전트 말"을 열로 복사해 두지 않고 replyTo 로 가리킨다. 에이전트 글을 전부
// 따로 저장하므로(2026-09-30 측정: 메인 3.1MB, 서브에이전트 1.8MB) "직전"의 정의를
// 나중에 바꿔도 다시 적재할 필요가 없다.
export const messages = pgTable(
  'messages',
  {
    // 사람 말은 transcript 줄 uuid, 에이전트 말은 message.id("msg_...").
    // 에이전트 응답 하나는 여러 줄로 쪼개져 기록되므로 turns 와 같은 키를 쓴다 — 조인도 된다.
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    // 'typed' = 직접 친 메시지, 'command' = "/이름" 입력, 'interrupt' = 작업 중 Esc 로 끊음,
    // 'assistant' = 에이전트가 쓴 글(text 블록).
    kind: text('kind', { enum: ['typed', 'command', 'interrupt', 'assistant'] }).notNull(),
    // 원문 그대로. 명령은 <command-name> 태그까지 포함한다 — 가공은 읽는 쪽이 한다.
    text: text('text').notNull(),
    sidechain: boolean('sidechain').notNull().default(false),
    // typed 메시지만: 이 말이 답한 에이전트 글의 id. parentUuid 사슬을 거슬러 올라가
    // 처음 만나는 "글이 있는 assistant 줄"이다. 그 전에 사람이 친 다른 메시지를 만나면
    // (연달아 두 번 보냄) 또는 세션 첫 메시지면 null 이다.
    replyTo: text('reply_to'),
  },
  (t) => [index('messages_session_ts_idx').on(t.sessionId, t.ts)],
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
    // 복수 선택 질문이었나. 2026-09-30 훅에 추가됐다. 그 전 행은 transcript 에서 한 번 채웠고,
    // transcript 가 이미 지워진 행은 null(모름)이다.
    // 추천 없는 질문 경보가 이걸 따로 센다 — "리뷰어가 볼 것 고르기" 같은 복수 선택은
    // 추천 하나가 어울리지 않는 질문이라, 섞어 세면 진짜 누락이 가려진다.
    multiSelect: boolean('multi_select'),
  },
  // 훅은 초 단위 ts를 남긴다. 한 번의 호출에 질문이 여럿이면 ts가 같으므로 question까지 키에 넣는다.
  // 같은 세션이 같은 초에 같은 문장을 두 번 묻는 일은 없다.
  (t) => [uniqueIndex('decisions_natural_key').on(t.sessionId, t.ts, t.question)],
)

// ---------------------------------------------------------------------------
// LLM 작업. claude -p 호출 한 번이 한 줄이다.
//
// 표로 두는 이유: 호출 하나에 수 초~수십 초가 걸리고 돈이 든다. 메모리에만 두면
// 프로세스가 죽을 때 "무엇을 이미 했나"가 사라져서 다시 돌리면 같은 호출에 또 돈을 쓴다.
// (kind, subject) 가 고유해서 같은 대상에 같은 작업을 두 번 넣을 수 없다.
// ---------------------------------------------------------------------------
export const llmJobs = pgTable(
  'llm_jobs',
  {
    id: serial('id').primaryKey(),
    // 작업 종류. 'question-kind' 등. 종류마다 handler 가 하나 있다(src/jobs/).
    kind: text('kind').notNull(),
    // 작업 대상의 식별자. question-kind 면 decisions.id. 문자열인 이유: 종류마다 대상 표가 다르다.
    subject: text('subject').notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull(),
    // 넣을 때 정해지는 재료. 프롬프트는 여기 없다 — 실행 시점에 만든다(아래 prompt).
    input: jsonb('input').notNull(),
    model: text('model'),
    // 실제로 보낸 프롬프트. 실행 시점의 상태(지금까지 만들어진 종류 목록 등)가 들어가므로
    // 넣을 때가 아니라 돌릴 때 채운다. 나중에 "왜 이렇게 답했나"를 볼 수 있는 유일한 기록이다.
    prompt: text('prompt'),
    output: jsonb('output'),
    error: text('error'),
    // claude -p 가 돌려주는 total_cost_usd. 구독으로 돌려도 API 환산값이 온다.
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('llm_jobs_kind_subject').on(t.kind, t.subject),
    // 실행기가 매번 묻는 질문이 "이 종류에서 가장 오래 기다린 queued 는?" 이다.
    index('llm_jobs_kind_status_idx').on(t.kind, t.status, t.id),
  ],
)

// 질문 종류. 에이전트가 수아에게 한 질문을 "같은 답이 통하는 묶음"으로 나눈 이름.
//
// 왜 필요한가: precedents.mjs 는 질문을 글자 겹침으로 묶는다. 같은 뜻을 다른 말로 물으면
// 다른 종류가 되어서, 2026-09-30 기준 답 196개가 종류 152개로 흩어졌다. 한 종류에 답이 2개
// 이상 쌓여야 "정해진 답"이 되는데 그럴 일이 거의 없었다. 뜻으로 묶으면 모인다.
//
// 종류는 미리 정해 두지 않는다. 분류하면서 처음 보는 뜻이 나오면 새 종류를 만든다.
export const questionKinds = pgTable('question_kinds', {
  name: text('name').primaryKey(),
  description: text('description').notNull(),
  // 이 종류를 처음 만든 작업. 어떤 질문을 보고 생겼는지 거슬러 갈 수 있다.
  createdByJob: integer('created_by_job').references(() => llmJobs.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// 결정 하나가 어느 종류인가. decisions 에 열을 더하지 않고 따로 두는 이유:
// decisions 는 훅 로그에서 적재되는 원본이고, 이건 LLM 이 만든 파생값이다.
// 섞어 두면 "원본을 다시 적재"와 "분류를 다시 돌림"이 서로를 덮는다.
export const decisionKinds = pgTable('decision_kinds', {
  decisionId: integer('decision_id')
    .primaryKey()
    .references(() => decisions.id),
  kind: text('kind')
    .notNull()
    .references(() => questionKinds.name),
  jobId: integer('job_id')
    .notNull()
    .references(() => llmJobs.id),
})

export type LlmJob = typeof llmJobs.$inferSelect

export type Session = typeof sessions.$inferSelect
export type Turn = typeof turns.$inferSelect
export type SkillInvocation = typeof skillInvocations.$inferSelect
export type ToolResult = typeof toolResults.$inferSelect
export type Message = typeof messages.$inferSelect
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
  toolResults: number // 읽은 tool_result 블록 수
  // tool_use 를 못 찾아 도구 이름을 모르는 tool_result (설명 안 됨).
  // 2026-09-29 전수 측정에서 0건이었다 — 짝은 항상 같은 파일 안에 있다.
  toolResultsUnmatched: number
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
  memoryDeny: number // type=memory-deny. 교정·선호를 프로젝트 메모리에 쓰려다 훅에 막힌 횟수 (예상됨)
  slackVoiceGate: number // type=slack-voice-gate. 대외 메시지 말투 확인 훅이 울린 횟수 (예상됨)
}

// 파서가 만들어 내는 모양. 카운터가 전부 있다.
export type IngestStats = { transcripts: TranscriptStats; events: EventStats }

// DB 에서 읽을 때의 모양. 같지 않다.
//
// stats 는 jsonb 라 스키마 강제가 없고, 한 열 안에 여러 시점의 모양이 섞여 산다.
// 카운터를 새로 만들면 그 전에 돌았던 행에는 그 키가 없다. 두 모양을 한 타입으로
// 쓰면 읽는 쪽이 거짓말을 하거나(없는 값을 number 로 보거나) 쓰는 쪽이 전부
// optional 이 되어 증가 코드가 깨진다. 그래서 갈라 둔다.
//
// 카운터를 추가할 때 여기 Partial 목록과 scheduler.ts 의 Type.Optional 을 같이 늘린다.
type LaterTranscriptKeys = 'toolResults' | 'toolResultsUnmatched'
type LaterEventKeys = 'memoryDeny' | 'slackVoiceGate'
export type StoredIngestStats = {
  transcripts: Omit<TranscriptStats, LaterTranscriptKeys> &
    Partial<Pick<TranscriptStats, LaterTranscriptKeys>>
  events: Omit<EventStats, LaterEventKeys> & Partial<Pick<EventStats, LaterEventKeys>>
}

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
  // 새로 들어온 대화 본문 행 수(messages). 2026-09-30 에 생긴 열이라 그 전 실행은 null 이다.
  // 사람 메시지와 에이전트 글을 합친 수라 "사람 메시지를 못 알아본다"는 이 숫자로는 안 보인다 —
  // 에이전트 글이 계속 들어와서 0이 되지 않는다. 그 고장은 따로 잡아야 한다.
  messages: integer('messages'),
  // 열을 열한 개 더 늘리지 않고 jsonb 하나에 둔다. 어떤 카운터가 실제로 드리프트를
  // 잡아내는지 아직 모르고, 카운터가 바뀔 때마다 스키마를 흔들고 싶지 않다.
  // 대신 API 응답 스키마(scheduler.ts)에서 필드 이름을 전부 못박아 계약은 유지한다.
  stats: jsonb('stats').$type<StoredIngestStats>(),
  error: text('error'),
})

export type IngestRun = typeof ingestRuns.$inferSelect
