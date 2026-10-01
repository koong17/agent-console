# agent-console

Claude Code 하네스(스킬, 게이트 훅, 세션)가 실제로 어떻게 쓰이는지 보는 개인 대시보드.
동시에 백엔드 학습 프로젝트. 서버가 자기 요청도 기록해서(`/traces`) 만들면서 생기는 실수가 화면에 바로 보인다.

로드맵, 스택 결정, 마일스톤, 진행 로그는 브레인 문서가 주인이다. 이 README는 **지금 뭐가 있고 어떻게 켜는지**만 적는다.
`~/workspace/suah-brain/projects/agent-harness-dashboard/agent-harness-dashboard.md`

## 켜기

준비물: Node 26 (`.nvmrc`, nvm 자동 전환), pnpm 11 (corepack), Postgres 15 (Homebrew).

```sh
brew services start postgresql@15   # 재부팅 후 안 떠 있으면
createdb agent_console              # 처음 한 번

pnpm install                        # git 훅(core.hooksPath)도 같이 잡힌다
cd apps/server
pnpm db:push                        # 스키마를 DB에 맞춘다 (마이그레이션 파일 없음)
pnpm db:seed                        # 모델 단가표

# 터미널 둘
pnpm dev:server                     # Fastify, 127.0.0.1:4000. 뜨면서 ingestion 한 번, 이후 1시간마다
pnpm dev:web                        # Next, localhost:3000
```

`/health` 가 `{"ok":true,"db":"up"}` 이면 정상. DB가 죽어 있으면 503.

## 구조

```
apps/server/            Fastify + Drizzle + Postgres
  src/app.ts              앱 조립(라우트 등록, swagger). listen은 index.ts
  src/trace.ts            자기 요청 추적 훅 + GET /traces
  src/usage.ts            집계 API: /usage/repos, /usage/daily, /usage/gates, /usage/skills/weekly
  src/sessions.ts         세션 목록·상세
  src/cost.ts             토큰 × 단가 SQL 조각
  src/schemas.ts          TypeBox 공통 조각 (DateTime, Nullable)
  src/db/schema.ts        테이블 정의 (아래)
  src/db/seed.ts          model_prices 초기값
  src/ingest/             transcript·훅 이벤트·브레인 평가 결과 읽어 DB에 넣기. scheduler.ts 가 주기 실행
  src/jobs/               LLM 작업(claude -p). runner.ts 가 llm_jobs 표를 큐로 쓴다. 종류마다 파일 하나
  src/evals.ts            eval 초안 대기열. 콘솔의 첫 쓰기 경로(브레인 레포에 draft 파일)
  src/audit.ts            혼자 한 결정 감사. 하루 10개 무작위로 묻고 판정을 DB 에 쓴다
  src/drill.ts            쌍 비교 드릴. 하루 5쌍, 관점별 Elo 는 고른 기록에서 매번 계산
  src/taste.ts            3단계 취향: 에이전트가 쓴 줄 중 기준 브랜치에 남은 비율(pnpm taste, LLM 없음)
  src/taste-blame.ts      같은 것을 커밋 기준으로(수아 명의 + Co-Authored-By Claude). 줄 주인은 git blame
  src/scoreboard.ts       대체 로드맵 점수판: 수아 분, 블라인드 재예측·보정, 개입, 교정 되짚기, 단계별, evals
  src/openapi-emit.ts     OpenAPI 스펙을 packages/contract 로 쓰기
apps/web/               Next 16, 서버 컴포넌트가 Fastify를 직접 호출 (CORS 없음)
  app/page.tsx            /          요청 추적 + ingestion 상태
  app/usage/              /usage     일별 비용, 레포별, 게이트 준수율, 스킬 주간 행렬
  app/sessions/           /sessions  세션 목록 → /sessions/[id] 응답별 토큰·비용
  app/scoreboard/         /scoreboard 브레인이 수아를 얼마나 대신하나
  app/drafts/             /drafts    eval 초안 고르기(규칙 없음은 주제별). 서버 액션으로 Fastify 에 POST
  app/audit/              /audit     에이전트가 묻지 않고 정한 결정에 맞아요/다르게 했을 것
  app/drill/              /drill     같은 내용, 다른 문체 두 글 중 나은 쪽 고르기
  app/server.ts           openapi-fetch 클라이언트. 타입은 packages/contract 에서
  app/globals.css         디자인 토큰과 공용 클래스. 규칙은 DESIGN.md
packages/contract/      openapi.json (서버가 생성) + openapi.d.ts (거기서 생성). 손으로 고치지 않음
scripts/, .githooks/    계약 신선도 검사 (아래)
```

## 테이블

| 테이블 | 한 줄 = | 출처 |
|---|---|---|
| `traces` | 이 서버가 받은 HTTP 요청 하나 | onResponse 훅 |
| `sessions` | Claude Code 세션 하나 | transcript 파일 |
| `turns` | 어시스턴트 응답 하나 (토큰 4종) | transcript, `message.id` 키 |
| `skill_invocations` | 스킬 호출 하나 | transcript 의 Skill tool_use |
| `gate_events` | suah-judge 게이트 울림 하나 (nudged/throttled) | `~/.claude/harness-events.jsonl` |
| `model_prices` | 모델별 USD/MTok 단가 | `pnpm db:seed` |
| `ingest_runs` | ingestion 실행 하나 (running/done/failed) | 스케줄러 |
| `messages` | 사람 메시지(typed/command/interrupt) 또는 에이전트 글 하나 | transcript. 사람 메시지는 `reply_to` 로 답한 글을 가리킨다 |
| `tool_results` | 도구 응답 하나 (바이트, 호출·응답 시각) | transcript 의 tool_result |
| `decisions` | 에이전트 질문에 대한 수아의 답 하나 | `harness-events.jsonl` 의 decision 줄 |
| `llm_jobs` | claude -p 호출 하나 (queued/running/done/failed, 비용) | `pnpm jobs` |
| `question_kinds`, `decision_kinds` | 뜻으로 묶은 질문 종류, 결정별 종류 | `pnpm jobs question-kind` |
| `shadow_predictions` | 결정 하나의 블라인드 재예측 | `pnpm jobs shadow-predict` |
| `message_intents` | 사람 메시지 하나의 개입 종류 | `pnpm jobs message-intent` |
| `correction_replays` | 교정 하나의 원인(규칙 없음/무시/틀림) | `pnpm jobs correction-replay` |
| `eval_drafts` | 교정 하나에서 만든 eval 케이스 초안 (pending/accepted/rejected) | `pnpm jobs eval-draft`, 저장은 /drafts |
| `agent_edits` | 에이전트의 Edit/Write 호출 하나(경로, 바꾼 내용, 실패 여부) | transcript |
| `edit_survival` | 수정 하나가 기준 브랜치에 얼마나 남았나(스냅숏) | `pnpm taste` |
| `drill_pairs` | 한 관점(길이·순서·말투)만 다르게 다시 쓴 글 두 개와 수아의 선택 | `pnpm jobs pair-drill`, 선택은 /drill |
| `taste_themes` | 취향 규칙 후보를 묶은 주제와 브레인에 이미 있는지(none/partial/full). /drafts 에서 inbox 로 | `pnpm jobs taste-theme` |
| `taste_findings` | 다시 쓰인 에이전트 커밋에서 누가 무엇을 바꿨나, 취향이면 규칙 후보 | `pnpm jobs taste-diff` |
| `commit_survival`, `taste_ownership` | 에이전트 커밋 하나가 남긴 줄 / 그 파일들의 지금 줄 주인 | `pnpm taste` |
| `draft_themes` | 규칙 없음 초안의 주제(새 규칙 후보 하나) | `pnpm jobs draft-theme` |
| `solo_decisions` | 에이전트가 묻지 않고 정한 결정 하나와 수아의 판정 | `pnpm jobs solo-decision`, 판정은 /audit |
| `answer_policies`, `decision_policies` | 질문 종류 안의 답을 판단(정책)으로 묶은 것 | `pnpm jobs answer-policy` |
| `eval_runs`, `eval_results` | 브레인 평가 실행과 케이스 결과 | `suah-brain/evals/results/*.json` |

키는 전부 원본의 ID다. 같은 파일을 다시 읽어도 `ON CONFLICT` 로 걸러져 중복이 안 생긴다.

## 데이터 출처

- `~/.claude/projects/<cwd-slug>/<session>.jsonl` — Claude Code transcript. **30일 뒤 삭제되므로** ingestion이 멈추면 데이터가 사라진다.
- `~/.claude/harness-events.jsonl` — 훅 두 개가 남기는 줄. `log-skill.sh`(스킬 호출), `suah-judge-gate.sh`(게이트 울림). 2026-09-02에 세션 ID와 cwd를 남기도록 고쳤다.
- 비용은 "API로 같은 양을 썼다면"의 환산값이다. 구독제라 실제 청구액이 아니다.

## 스크립트

| 어디서 | 명령 | 하는 일 |
|---|---|---|
| 루트 | `pnpm dev:server` / `pnpm dev:web` | 개발 서버 |
| 루트 | `pnpm contract` | 스펙 생성 + 타입 생성. 서버 라우트 스키마를 바꾸면 실행 |
| 루트 | `pnpm contract:check` | 스펙이 코드보다 뒤처졌는지 검사. pre-commit 훅이 서버 코드 커밋 때 자동 실행 |
| 루트 | `pnpm format` | prettier |
| apps/server | `pnpm ingest` | ingestion 수동 실행 (서버가 켜져 있으면 알아서 돈다) |
| apps/server | `pnpm db:push` / `db:seed` / `db:studio` | 스키마 적용 / 단가표 / 브라우저 DB 뷰어 |
| apps/server | `pnpm jobs <종류> [--limit N] [--retry-failed]` | LLM 작업 넣고 비우기. 종류: question-kind, shadow-predict, message-intent, correction-replay, answer-policy, eval-draft, draft-theme, solo-decision, taste-diff, taste-theme, pair-drill. 돈이 들어서 자동으로 안 돈다 |
| apps/server | `pnpm taste` | 에이전트 수정이 기준 브랜치(origin/develop → origin/main → main → HEAD)에 남은 비율을 다시 잰다. fetch 안 함 |
| apps/server | `pnpm test` | DATABASE_URL을 `agent_console_test`로 고정하고, 파일을 하나씩(--test-concurrency=1) 돈다 |
| apps/server | `pnpm test:db:push` | 테스트 DB에 스키마 적용. 스키마를 바꾸면 여기도 한 번 |
| HTTP | `POST /ingest/run`, `GET /ingest/status` | 수동 트리거(202), 실행 이력 |
| HTTP | `POST /evals/drafts/:id/accept`, `/reject` | 초안을 브레인 레포에 draft 파일로 저장(이미 있으면 409) / 버림 |
| HTTP | `POST /taste/themes/:id/accept`, `/reject` | 취향 규칙 한 줄을 suah-brain/inbox.md 끝에 덧붙임(커밋 안 함) / 버림 |

## 테스트

```sh
createdb agent_console_test     # 처음 한 번
cd apps/server
pnpm test:db:push               # 스키마를 바꿀 때마다
pnpm test
```

`src/**/*.test.ts` 67개(2026-10-01). 층으로 나뉜다.

- `lines.test.ts`, `transcripts.test.ts` — DB를 안 쓴다. `parseFile`이 파일을 읽어 메모리에 행을 모으는 데까지가 그 층이고, 카운터 로직도 전부 거기 있다.
- `ingest-file.test.ts` — DB를 쓴다. 트랜잭션·충돌 처리·멱등성은 여기서만 검증된다.
- `jobs/runner.test.ts` — LLM 작업. 진짜 claude 대신 PATH 맨 앞에 가짜 `claude` 실행 파일을 둔다. 브레인 레포도 임시 git 레포로 만든다.
- `scoreboard.test.ts` — 점수판 라우트를 `app.inject` 로 부른다. 집계 SQL 의 경계(전체 줄, 칸 끝)를 본다.

파일마다 같은 테스트 DB 표를 비우므로 파일을 동시에 돌리면 서로의 행을 지운다. 그래서 `--test-concurrency=1` 이다.

DB 테스트는 매 테스트 전에 표를 truncate 한다. 그래서 `pnpm test`가 DATABASE_URL을 테스트 DB로 고정하고, 그걸 우회해도 `before` 훅이 DB 이름이 `_test`로 끝나는지 한 번 더 본다.

## 서버 라우트를 바꿀 때

1. `src/*.ts` 의 TypeBox 스키마와 핸들러를 고친다. 응답 스키마에 없는 필드는 **잘려 나간다.**
2. `pnpm contract` 로 `packages/contract` 를 다시 만든다. 잊으면 pre-commit 훅이 막고 대신 만들어 준다.
3. 웹에서 `tsc` 가 깨진 곳이 고칠 곳이다.

## 규칙

- 작업 규칙: `CLAUDE.md`. 주석·문서·커밋 메시지 한글, 쉬운 말 설명, pnpm이 허용하는 최신 버전, 주석 넉넉히.
- 웹 UI: `apps/web/DESIGN.md`. 토큰과 클래스만 쓴다.
