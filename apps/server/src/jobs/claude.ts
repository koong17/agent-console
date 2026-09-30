// claude -p 를 한 번 부르는 함수. suah-brain 의 scripts/run-evals.mjs 의 ask() 를 옮겼다.
//
// SDK(@anthropic-ai/sdk) 대신 CLI 를 쓰는 이유: API 키가 아니라 이미 로그인된 구독으로 돈다.
// 대가로 호출마다 프로세스를 하나 띄운다(수 초). 작업 하나가 원래 수 초~수십 초라 비율로는 작다.
//
// 격리 네 겹. 이게 없으면 우리 훅·설정이 이 호출 안에서도 돈다.
//   빈 임시 폴더에서 실행       — 그 폴더엔 CLAUDE.md 가 없다
//   --setting-sources ""         — 사용자 설정을 안 읽는다. 훅도 같이 꺼진다
//                                  (안 끄면 결정 로그 훅 등이 이 호출을 사람 세션으로 기록한다)
//   --strict-mcp-config, --tools "" — MCP 도 도구도 없다. 답은 판단만 한다
//   --no-session-persistence     — transcript 를 안 남긴다. 남기면 사람 메시지 없이 에이전트 글만
//                                  쌓인 세션이 생겨 사람 메시지 침묵 경보(scheduler.ts)가 틀린다

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 호출 하나의 최대 시간. 넘으면 execFile 이 자식 프로세스를 죽인다.
// Haiku 분류 한 건이 실측 5.7초(2026-09-30)라 넉넉하게 잡았다. Opus 로 긴 글을 읽혀도
// 몇 분을 넘길 일은 없다. 이 값은 runner.ts 가 "죽은 running 행"을 가르는 기준에도 쓴다.
export const ASK_TIMEOUT_MS = 5 * 60 * 1000

export type AskArgs = {
  model: string
  systemPrompt: string
  prompt: string
  // 답의 모양. 주면 structured 에 파싱된 객체가 온다.
  jsonSchema?: object
}

export type AskResult = {
  text: string
  structured: unknown
  costUsd: number
  // 실제로 답한 모델의 전체 이름. 'haiku' 같은 별칭을 넘겨도 여기엔 버전까지 온다.
  model: string | null
}

export async function ask({ model, systemPrompt, prompt, jsonSchema }: AskArgs): Promise<AskResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-console-job-'))
  try {
    const args = [
      '-p',
      '--model', model,
      '--no-session-persistence',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--tools', '',
      '--output-format', 'json',
      '--system-prompt', systemPrompt,
    ]
    if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema))
    // 프롬프트는 맨 끝 인자. 셸을 거치지 않고(execFile) 인자 배열로 넘기므로 따옴표 이스케이프가 필요 없다.
    args.push(prompt)

    // 비동기 execFile 이라 기다리는 동안 이벤트 루프는 비어 있다 — 서버 안에서 돌려도 요청을 막지 않는다.
    // 적재(파일 파싱, CPU)와 다른 점이다.
    const { stdout } = await execFileAsync('claude', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: ASK_TIMEOUT_MS,
    })
    const parsed = JSON.parse(stdout) as {
      is_error?: boolean
      result?: string
      structured_output?: unknown
      total_cost_usd?: number
      modelUsage?: Record<string, unknown>
    }
    if (parsed.is_error) throw new Error(parsed.result ?? 'claude returned is_error')
    return {
      text: parsed.result ?? '',
      structured: parsed.structured_output ?? null,
      costUsd: parsed.total_cost_usd ?? 0,
      model: Object.keys(parsed.modelUsage ?? {})[0] ?? null,
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
