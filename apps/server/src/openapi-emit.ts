// OpenAPI 스펙을 packages/contract/openapi.json 으로 쓴다. 실행: pnpm openapi:emit
// 서버를 listen 하지 않는다. ready()까지만 가면 라우트가 전부 등록돼 스펙이 완성된다.
// 스펙 파일을 커밋하므로 API 변경이 git diff로 보인다.
import { writeFile } from 'node:fs/promises'
import { buildApp } from './app.js'
import { pool } from './db/index.js'

const OUT = new URL('../../../packages/contract/openapi.json', import.meta.url)

const app = await buildApp({ ingest: false })
await app.ready()
await writeFile(OUT, JSON.stringify(app.swagger(), null, 2) + '\n')
console.log(`openapi.json written (${Object.keys(app.swagger().paths ?? {}).length} paths)`)
await app.close()
await pool.end()
