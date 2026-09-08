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
  src/ingest/             transcript·훅 이벤트 읽어 DB에 넣기. scheduler.ts 가 주기 실행
  src/openapi-emit.ts     OpenAPI 스펙을 packages/contract 로 쓰기
apps/web/               Next 16, 서버 컴포넌트가 Fastify를 직접 호출 (CORS 없음)
  app/page.tsx            /          요청 추적 + ingestion 상태
  app/usage/              /usage     일별 비용, 레포별, 게이트 준수율, 스킬 주간 행렬
  app/sessions/           /sessions  세션 목록 → /sessions/[id] 응답별 토큰·비용
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
| HTTP | `POST /ingest/run`, `GET /ingest/status` | 수동 트리거(202), 실행 이력 |

## 서버 라우트를 바꿀 때

1. `src/*.ts` 의 TypeBox 스키마와 핸들러를 고친다. 응답 스키마에 없는 필드는 **잘려 나간다.**
2. `pnpm contract` 로 `packages/contract` 를 다시 만든다. 잊으면 pre-commit 훅이 막고 대신 만들어 준다.
3. 웹에서 `tsc` 가 깨진 곳이 고칠 곳이다.

## 규칙

- 작업 규칙: `CLAUDE.md`. 주석·문서·커밋 메시지 한글, 쉬운 말 설명, pnpm이 허용하는 최신 버전, 주석 넉넉히.
- 웹 UI: `apps/web/DESIGN.md`. 토큰과 클래스만 쓴다.
