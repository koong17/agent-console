import { pgTable, serial, text, integer, timestamp } from 'drizzle-orm/pg-core'

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
