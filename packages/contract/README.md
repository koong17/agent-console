# @agent-console/contract

서버의 OpenAPI 스펙과, 거기서 생성한 TypeScript 타입.

- `openapi.json` — 서버가 만든다. `apps/server`에서 `pnpm openapi:emit`. 손으로 고치지 않는다.
- `src/openapi.d.ts` — 스펙에서 생성한다. 이 폴더에서 `pnpm generate`. 손으로 고치지 않는다.

흐름: 서버 라우트의 TypeBox 스키마 → openapi.json → openapi.d.ts → 웹의 `openapi-fetch` 클라이언트.
서버 스키마를 바꾸면 위 두 명령을 다시 돌린다. 웹 타입이 맞지 않으면 `tsc`가 알려준다.

이 패키지만 TypeScript 5를 쓴다. openapi-typescript가 TS 7의 새 컴파일러 API를 아직 지원하지 않는다.
