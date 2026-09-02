import { defineConfig } from 'drizzle-kit'

// drizzle-kit CLI 전용 설정. 런타임 코드는 이 파일을 읽지 않는다.
// 마이그레이션 파일 없이 `drizzle-kit push`로 스키마를 DB에 직접 맞춘다.
// 두 번째 사용자가 생기면 generate + migrate로 바꾼다.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/agent_console',
  },
})
