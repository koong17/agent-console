// Claude Code transcript(~/.claude/projects/<cwd-slug>/<session>.jsonl)를 읽어
// sessions / turns / skill_invocations에 넣는다.
//
// 진입점은 둘이다. CLI(pnpm ingest, cli.ts)와 서버 안 스케줄러(scheduler.ts).
// 여러 번 돌려도 안전하다. 키가 원본 ID라서 이미 있는 행은 DB가 걸러낸다.
// sessions/skill_invocations 는 건너뛰고(onConflictDoNothing), turns 는 토큰 열만
// 더 큰 값으로 갱신한다(onConflictDoUpdate + greatest). 같은 파일을 다시 읽으면
// 결과가 같은 값으로 수렴한다 — "아무것도 안 바꿈"이 아니라 "같은 상태로 수렴".

import { glob } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { readLines } from './lines.js'
import { sessions, turns, skillInvocations, toolResults, messages, type TranscriptStats } from '../db/schema.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// transcript 한 줄. 필요한 필드만 적었다. 나머지는 무시된다.
// Claude Code 내장 슬래시 명령. 사용자 메시지의 <command-name>에 나오지만 스킬이 아니다.
// 이 목록에 없는 이름만 skill_invocations 에 넣는다. 새 내장 명령이 생기면 여기 추가.
const BUILTIN_COMMANDS = new Set([
  'clear',
  'model',
  'exit',
  'quit',
  'copy',
  'login',
  'logout',
  'plugin',
  'plugins',
  'insights',
  'resume',
  'help',
  'config',
  'settings',
  'status',
  'cost',
  'compact',
  'memory',
  'init',
  'doctor',
  'bug',
  'review',
  'permissions',
  'mcp',
  'agents',
  'hooks',
  'vim',
  'terminal-setup',
  'export',
  'rename',
  'tasks',
  'artifacts',
  'fast',
  'loop',
  'workflows',
  'context',
  'usage',
  'upgrade',
  'release-notes',
  'add-dir',
  'ide',
  'install-github-app',
  'install-slack-app',
  'pr-comments',
  'diff',
  'rewind',
  'theme',
  'keybindings',
])

// 2026-09-10 기준 실제 트랜스크립트에 나타나는 type 전부(22종). 여기 없는 type 이
// 나오면 unknownTypeLines 로 센다. 그게 "상류가 형식을 바꿨다"의 신호다.
//
// 대가를 알고 쓴다: Claude Code 가 무해한 새 type 을 추가하기만 해도 경보가 울린다.
// 오탐이지만 받아들인다 — "처음 보는 줄 모양이 나왔다"는 어차피 알고 싶은 사실이고,
// 고치는 비용은 여기에 한 줄 추가다. BUILTIN_COMMANDS 와 같은 종류의 유지보수 목록.
export const KNOWN_TYPES = new Set([
  'assistant',
  'attachment',
  'user',
  'mode',
  'last-prompt',
  'bridge-session',
  'system',
  'ai-title',
  'atis-latch',
  'file-history-snapshot',
  'queue-operation',
  'permission-mode',
  'pr-link',
  'custom-title',
  'file-history-delta',
  'frame-link',
  'cost-state',
  'agent-name',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
])

// 트랜스크립트가 아닌데 glob 이 같이 집는 파일. 대화가 아니라 워크플로 실행 기록이라
// 세션도 턴도 없다. 빼지 않으면 filesEmpty 가 영원히 1이고, 그러면
// "설명 안 되는 탈락 = 0" 이라는 기준이 성립하지 않는다.
//
// 이름을 하나만 박아두는 게 위험해 보이지만, 앞으로 다른 비-트랜스크립트 파일이
// 섞여 들어오면 그 파일의 type 들이 unknownTypeLines 로 잡힌다. 목록을 미리
// 완벽하게 만들 필요가 없는 이유다.
const NOT_TRANSCRIPT = new Set(['journal.jsonl'])

// type 이 문자열이 아닌 줄(필드 자체가 사라진 경우)에 쓸 이름. 집계 키로 쓰려면
// 이름이 있어야 하고, 실제 type 과 겹치지 않게 꺾쇠를 붙인다.
const NO_TYPE = '<none>'

type Line = {
  type: string
  uuid?: string
  // 대화는 줄들의 사슬이다. 각 줄이 바로 앞 줄의 uuid 를 가리킨다.
  parentUuid?: string | null
  // 훅·시스템이 사용자 자리에 끼워 넣은 줄. 사람이 친 게 아니다.
  isMeta?: boolean
  // 사용자 줄을 누가 만들었나. 사람이 친 메시지는 { kind: 'human' }.
  origin?: { kind?: string }
  isSidechain?: boolean
  sessionId?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  message?: {
    id?: string
    role?: string
    model?: string
    usage?: {
      input_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
      output_tokens: number
    }
    content?: MessageContent
  }
}

type ContentBlock = {
  type: string
  id?: string
  name?: string
  text?: string
  input?: Record<string, unknown>
  // tool_result 블록. 이름은 없고 어떤 호출의 결과인지만 가리킨다.
  tool_use_id?: string
  content?: unknown
}

type MessageContent = string | ContentBlock[]

// content 에서 text 블록만 이어 붙인다. 문자열이면 그대로.
function textOf(content: MessageContent | undefined) {
  if (typeof content === 'string') return content
  return (content ?? [])
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
}

// 사용자 줄 가운데 messages 에 담을 것만 종류를 돌려준다. 나머지는 null.
//
// 순서가 중요하다. "/이름" 입력도 origin 이 human 일 때가 있어서 명령을 먼저 가른다.
// typed 를 origin 으로 판정하는 이유: 로컬 명령 출력, 작업 알림도 같은 user 줄이고
// 본문 모양으로는 끝없이 예외를 쌓아야 한다. 2026-09-30 측정에서 사람이 친 1,506줄이
// 전부 origin.kind = 'human' 이었고, 아닌 1줄은 SDK 로 돌린 평가 프롬프트였다.
//
// 실패 지점: Claude Code 가 origin 필드를 없애거나 이름을 바꾸면 typed 가 조용히 0이 된다.
function userKind(line: Line, text: string): 'typed' | 'command' | 'interrupt' | null {
  if (line.isMeta || !text) return null
  if (text.includes('<command-name>')) return 'command'
  if (text.startsWith('[Request interrupted')) return 'interrupt'
  if (line.origin?.kind === 'human') return 'typed'
  return null
}

// 사슬 한 칸. 줄 uuid 로 찾는다.
type ChainNode = {
  parent: string | null
  // 이 줄이 글(text 블록)을 가진 assistant 줄이면 그 응답의 message.id
  textMsgId?: string
  // 이 줄이 사람이 직접 친 메시지면 true
  typed?: boolean
}

// 사람 메시지가 답한 에이전트 글을 찾는다. 부모 쪽으로 거슬러 올라가며
// 처음 만나는 "글이 있는 assistant 줄"의 id 를 돌려준다.
//
// 지나쳐 가는 줄: 도구 호출만 있는 assistant 줄, tool_result, 훅 주입, 명령, 끊김.
// 멈추는 줄: 사람이 친 이전 메시지 — 그 사이 에이전트가 글로 한 말이 없었다는 뜻이다.
//
// 시각(ts)으로 "바로 앞 assistant"를 고르지 않는 이유: 에이전트가 일하는 중에 친
// 메시지(queued)는 ts 순서와 대화 순서가 다르고, 서브에이전트 줄이 시간상 끼어든다.
// 사슬은 transcript 가 직접 기록한 "무엇 다음에 무엇"이라 그 추측이 필요 없다.
function findReplyTo(chain: Map<string, ChainNode>, start: string | null | undefined) {
  let cur = start
  // 사슬이 고리를 이루면 무한 루프다. 정상 파일에선 없지만, 한 번 방문한 줄을 다시
  // 밟을 수 없으니 줄 수만큼 걸으면 반드시 끝난다.
  for (let hops = 0; cur && hops < chain.size; hops++) {
    const node = chain.get(cur)
    if (!node || node.typed) return null
    if (node.textMsgId) return node.textMsgId
    cur = node.parent
  }
  return null
}

// 사용자 메시지 본문에서 "/스킬이름 인자" 입력을 찾는다. Claude Code는 이를
//   <command-name>/feature-plan</command-name> ... <command-args>TMS-1234</command-args>
// 형태로 기록한다. 한 메시지에 여러 개일 수 있어 배열로 돌려준다.
function parseCommands(content: MessageContent | undefined) {
  const texts: string[] =
    typeof content === 'string' ? [content] : (content ?? []).map((c) => c.text ?? '').filter(Boolean)
  const out: Array<{ skill: string; args: string }> = []
  for (const t of texts) {
    const names = [...t.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)].map((m) => m[1]!.trim())
    const args = [...t.matchAll(/<command-args>([^<]*)<\/command-args>/g)].map((m) => m[1]!.trim())
    names.forEach((name, i) => {
      if (!BUILTIN_COMMANDS.has(name)) out.push({ skill: name, args: args[i] ?? '' })
    })
  }
  return out
}

// 카운터를 0으로 시작한 새 객체. ingestTranscripts 와 테스트가 같은 초기 상태를 쓴다.
// 인라인 리터럴로 두면 카운터를 추가할 때 한쪽만 고치고 다른 쪽은 undefined 로 남는다.
export function emptyTranscriptStats(): TranscriptStats {
  return {
    lines: 0,
    badJson: 0,
    filesEmpty: 0,
    typeCounts: {},
    unknownTypeLines: 0,
    toolResults: 0,
    toolResultsUnmatched: 0,
    assistantLines: 0,
    synthetic: 0,
    unusable: 0,
  }
}

type Parsed = {
  session: typeof sessions.$inferInsert
  turns: Array<typeof turns.$inferInsert>
  skills: Array<typeof skillInvocations.$inferInsert>
  tools: Array<typeof toolResults.$inferInsert>
  messages: Array<typeof messages.$inferInsert>
}

// 파일 하나를 끝까지 읽어 넣을 행들을 메모리에 모은다.
// 264MB짜리 폴더를 통째로 읽지 않고 파일 단위로 처리하는 이유다.
//
// stats는 호출자가 넘긴 실행 단위 누적기다. 반환값에 얹지 않고 인자로 받는 이유:
// 카운터는 파일별 결과가 아니라 실행 전체의 합이고, 파일마다 합치는 코드를
// 호출부에 또 쓰고 싶지 않아서다.
export async function parseFile(path: string, stats: TranscriptStats): Promise<Parsed | null> {
  let session: typeof sessions.$inferInsert | null = null
  // 같은 message.id가 여러 줄에 나오므로 Map으로 한 번만 담는다.
  const turnMap = new Map<string, typeof turns.$inferInsert>()
  const skills: Parsed['skills'] = []
  const tools: Parsed['tools'] = []
  // tool_result 줄에는 도구 이름이 없다. 이름은 앞선 assistant 줄의 tool_use 블록에 있고
  // tool_use_id 로 이어진다. 파일을 순서대로 읽으므로 호출을 먼저 만나 여기 담아두고,
  // 결과를 만났을 때 꺼내 쓴다. 전수 측정(2026-09-29)에서 짝이 다른 파일에 있는 경우는 0건이었다.
  const toolNames = new Map<string, { name: string; calledAt: Date }>()
  // 줄 사슬. replyTo 를 찾으려고 파일 안의 모든 줄을 uuid 로 기억한다.
  // 부모는 항상 자식보다 파일 앞에 있어서 사람 메시지를 만난 순간 바로 거슬러 올라갈 수 있다.
  const chain = new Map<string, ChainNode>()
  // 에이전트 글은 message.id 하나가 여러 줄에 걸칠 수 있어 Map 으로 모은다(turnMap 과 같은 이유).
  const msgMap = new Map<string, typeof messages.$inferInsert>()

  for await (const raw of readLines(path)) {
    stats.lines++
    let line: Line
    try {
      line = JSON.parse(raw)
    } catch {
      stats.badJson++ // 잘린 줄(강제 종료 등)은 건너뛴다
      continue
    }

    // sessionId 검사보다 먼저 센다. sessionId 필드 이름이 바뀌는 경우에도
    // type 집계는 남아야 "줄은 멀쩡히 있었다"를 보여줄 수 있다.
    const type = typeof line.type === 'string' ? line.type : NO_TYPE
    stats.typeCounts[type] = (stats.typeCounts[type] ?? 0) + 1
    if (!KNOWN_TYPES.has(type)) stats.unknownTypeLines++

    // 사슬은 sessionId 검사보다 먼저 기록한다. 세션 필드가 없는 줄도 사슬의 한 칸일 수 있고,
    // 빠지면 그 너머로 못 올라간다.
    const node: ChainNode = { parent: line.parentUuid ?? null }
    if (line.uuid) chain.set(line.uuid, node)

    // 여기 걸리는 줄은 세지 않는다. summary, file-history-snapshot 처럼 세션 필드가
    // 원래 없는 줄이 정상적으로 많이 섞여 있어서, 세면 신호가 아니라 잡음이 된다.
    // sessionId 이름 자체가 바뀌는 경우는 filesEmpty 가 대신 잡는다.
    if (!line.sessionId || !line.timestamp) continue
    const ts = new Date(line.timestamp)

    if (!session && line.cwd) {
      session = {
        id: line.sessionId,
        cwd: line.cwd,
        repo: basename(line.cwd),
        gitBranch: line.gitBranch ?? null,
        cliVersion: line.version ?? null,
        startedAt: ts,
        lastSeenAt: ts,
      }
    } else if (session) {
      if (ts < session.startedAt) session.startedAt = ts
      if (ts > session.lastSeenAt) session.lastSeenAt = ts
      if (line.gitBranch) session.gitBranch = line.gitBranch
    }

    // 도구 응답. 사용자 메시지 안에 tool_result 블록으로 들어온다(모델이 아니라 하네스가 채운다).
    // 크기를 재는 이유는 컨텍스트 곡선이 뛰는 자리에 이름을 붙이기 위해서다.
    // JSON.stringify 로 재는 건 "이 내용이 대화에 실릴 때의 대략적 부피"에 가장 가까운 값이라서다.
    if (line.type === 'user' && Array.isArray(line.message?.content)) {
      for (const b of line.message.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        stats.toolResults++
        const call = toolNames.get(b.tool_use_id)
        if (!call) {
          // 짝을 못 찾았다. 평소 0이어야 한다 — 0이 아니면 파일 안에서 호출과 결과가
          // 갈라졌거나 우리가 tool_use 를 못 읽고 있다는 뜻이다.
          stats.toolResultsUnmatched++
          continue
        }
        tools.push({
          id: b.tool_use_id,
          sessionId: line.sessionId!,
          repo: session?.repo ?? null,
          ts,
          tool: call.name,
          calledAt: call.calledAt,
          bytes: JSON.stringify(b.content ?? '').length,
        })
      }
    }

    // 대화 본문. 서브에이전트의 user 줄은 부모 에이전트가 넘긴 지시라 사람 말이 아니다.
    // tool_result 가 섞인 줄은 도구 응답이라 뺀다.
    if (line.type === 'user' && line.uuid && !line.isSidechain) {
      const content = line.message?.content
      const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
      const text = hasToolResult ? '' : textOf(content)
      const kind = userKind(line, text)
      if (kind) {
        if (kind === 'typed') node.typed = true
        msgMap.set(line.uuid, {
          id: line.uuid,
          sessionId: line.sessionId,
          ts,
          kind,
          text,
          sidechain: false,
          replyTo: kind === 'typed' ? findReplyTo(chain, line.parentUuid) : null,
        })
      }
    }

    // 사용자가 직접 친 "/스킬" 입력. 도구 호출이 아니라서 아래 tool_use 루프에는 안 잡힌다.
    if (line.type === 'user' && line.message && line.uuid) {
      parseCommands(line.message.content).forEach((c, i) => {
        skills.push({
          // 사용자 메시지엔 tool_use id가 없다. 줄 uuid + 순번으로 고유 키를 만든다.
          id: `cmd:${line.uuid}:${i}`,
          sessionId: line.sessionId!,
          repo: session?.repo ?? null,
          ts,
          skill: c.skill,
          args: c.args,
          source: 'command',
        })
      })
      continue
    }

    if (line.type !== 'assistant' || !line.message) continue
    const m = line.message
    stats.assistantLines++
    // '<synthetic>'은 API 에러 등을 Claude Code가 만들어 넣은 가짜 응답. 토큰 0.
    // 예상된 탈락이라 unusable 과 따로 센다.
    if (m.model === '<synthetic>') {
      stats.synthetic++
      continue
    }
    // 여기 걸리면 assistant 줄인데 우리가 쓰는 필드가 없다는 뜻이다. 평소 0이어야 한다.
    // 상류가 usage/id 필드 이름을 바꾸면 이 숫자가 assistantLines 와 같아진다.
    if (!m.id || !m.usage || !m.model) {
      stats.unusable++
      continue
    }

    const row = {
      id: m.id,
      sessionId: line.sessionId,
      ts,
      model: m.model,
      sidechain: line.isSidechain === true,
      inputTokens: m.usage.input_tokens,
      cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
      cacheCreation1hTokens: m.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      outputTokens: m.usage.output_tokens,
    }
    const prev = turnMap.get(m.id)
    if (!prev) {
      turnMap.set(m.id, row)
    } else {
      // 같은 응답이 여러 줄에 걸쳐 기록되고, 줄마다 usage 가 같지 않다.
      // Claude Code 는 스트리밍 중간 상태를 먼저 쓰고 완성본을 나중에 쓴다.
      // 그래서 첫 줄을 채택하면 output_tokens 가 미완성 값으로 굳는다 —
      // 2026-09-10 측정: 전체 output 토큰의 22.75%가 이렇게 누락돼 있었다.
      //
      // 마지막 줄 대신 항목별 max 를 쓴다. 실측으로 값이 줄어드는 경우는 0건이라
      // 두 방식의 결과가 같지만, max 는 "완성본이 파일에서 나중"이라는 순서 가정에
      // 기대지 않는다. 이 파일 형식은 우리가 통제하지 않으므로 가정을 줄인다.
      //
      // 토큰만 max 로 합친다. ts/model/sidechain 은 첫 줄 값을 유지한다 —
      // ts 를 마지막 줄로 옮기면 일별 비용 집계의 날짜 경계가 조용히 움직인다.
      prev.inputTokens = Math.max(prev.inputTokens, row.inputTokens)
      prev.cacheReadTokens = Math.max(prev.cacheReadTokens, row.cacheReadTokens)
      prev.cacheCreationTokens = Math.max(prev.cacheCreationTokens, row.cacheCreationTokens)
      // 이 열만 스키마에 default(0)이 있어서 타입이 optional 이다. 값은 항상 채워 넣지만 좁혀준다.
      prev.cacheCreation1hTokens = Math.max(prev.cacheCreation1hTokens ?? 0, row.cacheCreation1hTokens)
      prev.outputTokens = Math.max(prev.outputTokens, row.outputTokens)
    }

    // 에이전트가 글로 한 말. 도구 호출만 있는 줄은 글이 비어 건너뛴다.
    const said = textOf(m.content)
    if (said) {
      node.textMsgId = m.id
      const prevMsg = msgMap.get(m.id)
      if (!prevMsg) {
        msgMap.set(m.id, { id: m.id, sessionId: line.sessionId, ts, kind: 'assistant', text: said, sidechain: line.isSidechain === true })
      } else if (prevMsg.text !== said) {
        // 한 응답에 글 블록이 둘 이상이면 줄이 나뉜다. 순서대로 잇는다.
        // 2026-09-30 측정에서 이런 응답은 0건이었지만, 오면 뒤 블록을 잃지 않게 한다.
        prevMsg.text += '\n' + said
      }
    }

    for (const block of typeof m.content === 'string' ? [] : (m.content ?? [])) {
      // 도구 이름을 id 로 기억해둔다. 뒤에 올 tool_result 가 이걸로 이름을 찾는다.
      if (block.type === 'tool_use' && block.id && block.name) toolNames.set(block.id, { name: block.name, calledAt: ts })
      if (block.type !== 'tool_use' || block.name !== 'Skill' || !block.id) continue
      const input = block.input ?? {}
      skills.push({
        id: block.id,
        sessionId: line.sessionId,
        repo: session?.repo ?? null,
        ts,
        skill: String(input.skill ?? ''),
        args: String(input.args ?? ''),
        source: 'tool',
      })
    }
  }

  if (!session) return null
  return { session, turns: [...turnMap.values()], skills, tools, messages: [...msgMap.values()] }
}

// INSERT 한 문장에 넣을 행 수. Postgres는 문장당 파라미터 65535개 제한이 있어서
// 열 8개 × 500행 = 4000개로 넉넉히 아래에 둔다.
const CHUNK = 500

function chunks<T>(arr: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK))
  return out
}

export async function ingestFile(path: string, stats: TranscriptStats) {
  const parsed = await parseFile(path, stats)
  if (!parsed) {
    // 줄은 있는데 세션을 못 만들었다는 건 cwd/sessionId 를 한 줄도 못 읽었다는 뜻이다.
    // 진짜 빈 파일도 여기 걸리므로 0이 아닌 기준선이 있을 수 있다. 급증이 신호다.
    stats.filesEmpty++
    return { turns: 0, turnsUpdated: 0, skills: 0, messages: 0 }
  }

  // 파일 하나 = 트랜잭션 하나. 중간에 죽으면 그 파일은 하나도 안 들어간 상태로 남아
  // 다음 실행이 처음부터 다시 넣는다. 세션만 들어가고 turn은 없는 반쪽 상태를 막는다.
  return db.transaction(async (tx) => {
    // 세션은 "있으면 갱신". 다시 읽을 때 last_seen_at이 늘어나야 한다.
    await tx
      .insert(sessions)
      .values(parsed.session)
      .onConflictDoUpdate({
        target: sessions.id,
        set: { lastSeenAt: parsed.session.lastSeenAt, gitBranch: parsed.session.gitBranch },
      })

    let insertedTurns = 0
    let updatedTurns = 0
    for (const batch of chunks(parsed.turns)) {
      // 예전에는 onConflictDoNothing 이었다. 그러면 한 번 잘못 들어간 토큰 값이
      // 영구히 남는다 — 실제로 output_tokens 미완성 값 5009행이 그렇게 굳어 있었다.
      // 이제 토큰 열만 갱신한다. 나머지 열(ts/model/sidechain)은 안 건드린다.
      //
      // setWhere 가 핵심이다. 이게 없으면 매 실행마다 2만 행을 의미 없이 덮어쓰고,
      // returning 이 그 행을 다 돌려줘서 "turns +N"이 항상 2만이 된다 — 카운터가 거짓말한다.
      // 조건을 "토큰이 하나라도 커질 때"로 두면 정상 실행에서는 갱신이 0건이고,
      // returning 은 새로 들어간 행만 돌려준다. 카운터의 뜻이 유지된다.
      //
      // GREATEST 로 합치는 이유: 한 실행 안에서는 parseFile 이 이미 max 를 냈지만,
      // DB 에 이미 있는 행과 비교하면 이번 값이 더 작을 수도 있다(파일이 잘려 다시 읽히는 경우).
      // 내려가는 갱신을 만들지 않는다.
      const rows = await tx
        .insert(turns)
        .values(batch)
        .onConflictDoUpdate({
          target: turns.id,
          set: {
            inputTokens: sql`greatest(${turns.inputTokens}, excluded.input_tokens)`,
            cacheReadTokens: sql`greatest(${turns.cacheReadTokens}, excluded.cache_read_tokens)`,
            cacheCreationTokens: sql`greatest(${turns.cacheCreationTokens}, excluded.cache_creation_tokens)`,
            cacheCreation1hTokens: sql`greatest(${turns.cacheCreation1hTokens}, excluded.cache_creation_1h_tokens)`,
            outputTokens: sql`greatest(${turns.outputTokens}, excluded.output_tokens)`,
          },
          setWhere: sql`excluded.input_tokens > ${turns.inputTokens}
            or excluded.cache_read_tokens > ${turns.cacheReadTokens}
            or excluded.cache_creation_tokens > ${turns.cacheCreationTokens}
            or excluded.cache_creation_1h_tokens > ${turns.cacheCreation1hTokens}
            or excluded.output_tokens > ${turns.outputTokens}`,
        })
        // xmax=0 이면 이 행은 INSERT 였다. 0이 아니면 UPDATE 다.
        // Postgres 가 행마다 들고 있는 시스템 열이라 별도 조회 없이 둘을 가른다.
        .returning({ id: turns.id, inserted: sql<boolean>`(xmax = 0)` })
      for (const r of rows)
        if (r.inserted) insertedTurns++
        else updatedTurns++
    }

    let insertedSkills = 0
    for (const batch of chunks(parsed.skills)) {
      const rows = await tx
        .insert(skillInvocations)
        .values(batch)
        .onConflictDoNothing()
        .returning({ id: skillInvocations.id })
      insertedSkills += rows.length
    }

    // 도구 응답은 한 번 쓰이면 안 바뀐다. 이미 있으면 건너뛴다 — 단 called_at 만은 예외다.
    // 이 열이 생기기 전(2026-09-30)에 들어간 행은 비어 있어서, 비어 있을 때만 한 번 채운다.
    // 조건이 없으면 매 실행 수만 행을 같은 값으로 덮어쓴다(turns 의 setWhere 와 같은 이유).
    for (const batch of chunks(parsed.tools)) {
      await tx
        .insert(toolResults)
        .values(batch)
        .onConflictDoUpdate({
          target: toolResults.id,
          set: { calledAt: sql`excluded.called_at` },
          setWhere: sql`${toolResults.calledAt} is null and excluded.called_at is not null`,
        })
    }

    // 본문. 대부분 한 번 쓰이면 안 바뀌지만, 적재가 진행 중인 세션을 읽을 수 있다.
    // 응답의 글 블록이 두 줄에 걸쳐 있고 두 번째 줄이 아직 안 쓰였다면 앞부분만 들어간다.
    // 그래서 onConflictDoNothing 대신 "더 길어졌을 때만" 갱신한다 — turns 의 greatest 와 같은 발상.
    // setWhere 가 없으면 매 실행 수천 행을 덮어쓰고 xmax 구분도 무의미해진다.
    let insertedMessages = 0
    for (const batch of chunks(parsed.messages)) {
      const rows = await tx
        .insert(messages)
        .values(batch)
        .onConflictDoUpdate({
          target: messages.id,
          set: { text: sql`excluded.text` },
          setWhere: sql`length(excluded.text) > length(${messages.text})`,
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` })
      insertedMessages += rows.filter((r) => r.inserted).length
    }

    return { turns: insertedTurns, turnsUpdated: updatedTurns, skills: insertedSkills, messages: insertedMessages }
  })
}

export type TranscriptSummary = {
  files: number
  turns: number
  // 이미 있던 행의 토큰이 더 큰 값으로 교정된 수. 정상 실행에서는 0이어야 한다.
  turnsUpdated: number
  skills: number
  messages: number
  stats: TranscriptStats
}

export async function ingestTranscripts(): Promise<TranscriptSummary> {
  const total = { files: 0, turns: 0, turnsUpdated: 0, skills: 0, messages: 0 }
  const stats = emptyTranscriptStats()

  // '**' 로 서브에이전트 파일까지 훑는다. 위치:
  //   <proj>/<session>.jsonl                                  메인 대화
  //   <proj>/<session>/subagents/agent-*.jsonl                Agent 도구 서브에이전트
  //   <proj>/<session>/subagents/workflows/<wf>/agent-*.jsonl Workflow 도구 안의 에이전트
  // 서브에이전트 줄의 sessionId는 부모와 같아서 같은 세션에 turns가 붙는다.
  for await (const path of glob(join(PROJECTS_DIR, '**', '*.jsonl'))) {
    if (NOT_TRANSCRIPT.has(basename(path))) continue
    const r = await ingestFile(path, stats)
    total.files++
    total.turns += r.turns
    total.turnsUpdated += r.turnsUpdated
    total.skills += r.skills
    total.messages += r.messages
  }

  return { ...total, stats }
}
