import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'

// 인증 없음, 로컬 소켓. 두 번째 사용자가 생길 때까지는 이걸로 충분하다.
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/agent_console'

// Pool은 열어둔 연결을 재사용한다. 요청마다 새 연결을 맺으면
// TCP + 인증 핸드셰이크가 매번 붙어 쿼리 자체보다 오래 걸린다.
export const pool = new pg.Pool({ connectionString: DATABASE_URL })

// drizzle 인스턴스는 pool 위의 얇은 쿼리 빌더다. 실제 연결 관리는 pool이 한다.
export const db = drizzle(pool, { schema })
