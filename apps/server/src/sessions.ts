import { Type } from 'typebox'
import type { App } from './app.js'
import { DateTime, Nullable } from './schemas.js'
import { asc, count, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { sessions, turns, modelPrices, skillInvocations, toolResults } from './db/schema.js'
import { carryCostUsd, turnCostUsd, totalCostUsd } from './cost.js'

const sumInt = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::bigint`.mapWith(Number)

const SessionSummary = Type.Object({
  id: Type.String(),
  repo: Type.String(),
  gitBranch: Nullable(Type.String()),
  startedAt: DateTime,
  lastSeenAt: DateTime,
  turns: Type.Integer(),
  models: Type.Array(Type.String()),
  outputTokens: Type.Integer(),
  costUsd: Nullable(Type.Number()),
  // costUsd 중 캐시 읽기(= 컨텍스트 운반)가 차지하는 몫. 비율은 화면에서 나눈다 —
  // 서버가 비율까지 내려주면 분모를 두 곳에서 정의하게 된다.
  carryUsd: Nullable(Type.Number()),
})

const Session = Type.Object({
  id: Type.String(),
  cwd: Type.String(),
  repo: Type.String(),
  gitBranch: Nullable(Type.String()),
  cliVersion: Nullable(Type.String()),
  startedAt: DateTime,
  lastSeenAt: DateTime,
})

const TurnWithCost = Type.Object({
  id: Type.String(),
  ts: DateTime,
  model: Type.String(),
  inputTokens: Type.Integer(),
  cacheReadTokens: Type.Integer(),
  cacheCreationTokens: Type.Integer(),
  outputTokens: Type.Integer(),
  costUsd: Nullable(Type.Number()),
  // 서브에이전트(Agent 도구로 띄운 별도 대화)의 응답인지. 화면이 이걸 알아야 하는 이유:
  // 서브에이전트는 자기만의 컨텍스트 창을 쓴다. 메인 대화와 한 줄에 그리면 창 두 개가
  // 번갈아 찍혀 톱니가 되고, 그게 압축으로 오독된다.
  sidechain: Type.Boolean(),
})

// 이 세션에서 불린 스킬 하나. source: 'tool' = 모델이 Skill 도구로 호출,
// 'command' = 사용자가 "/이름" 으로 직접 입력. 무엇이 언제 불렸는지가 세션의 줄거리다.
const SkillMarker = Type.Object({
  id: Type.String(),
  ts: DateTime,
  skill: Type.String(),
  source: Type.Union([Type.Literal('tool'), Type.Literal('command')]),
})

// 이 세션에서 컨텍스트를 가장 많이 차지한 도구들.
// 곡선(ContextChart)이 "여기서 뛰었다"까지 말하고, 이 표가 "무엇 때문인지"를 말한다.
//
// 개별 응답이 아니라 도구별로 묶는다. 처음엔 큰 응답 10개를 그대로 내렸는데, 화면이
// 늘 같은 도구 열 줄이었다(한 세션은 mcp__claude-in-chrome__computer 10개,
// 다른 세션은 mcp__figma-dev__get_screenshot 10개). 지배적인 도구 하나가 목록을 채워서
// "무엇이 컨텍스트를 먹었나"를 한 줄로도 못 읽는다. 묶으면 한 줄이 그 답이 되고,
// maxBytes 가 "단일 응답 중 가장 큰 것"이라는 정보도 같이 남긴다.
const ToolResultByTool = Type.Object({
  tool: Type.String(),
  count: Type.Integer(),
  bytes: Type.Integer(),
  maxBytes: Type.Integer(),
})

const ToolResultSummary = Type.Object({
  total: Type.Integer(),
  totalBytes: Type.Integer(),
  byTool: Type.Array(ToolResultByTool),
})

const SessionDetail = Type.Object({
  session: Session,
  turns: Type.Array(TurnWithCost),
  // 시간순. 세션에서 스킬을 안 썼으면 빈 배열.
  skills: Type.Array(SkillMarker),
  toolResults: ToolResultSummary,
  totalCostUsd: Nullable(Type.Number()),
})

const NotFound = Type.Object({ error: Type.String() })



export function sessionRoutes(app: App) {
  // 세션 목록. 비용은 turns ⨝ model_prices 를 세션별로 SUM 한다.
  app.get(
    '/sessions',
    {
      schema: {
        querystring: Type.Object({ repo: Type.Optional(Type.String()) }),
        response: { 200: Type.Array(SessionSummary) },
      },
    },
    async (req) => {
      const { repo } = req.query

      return db
        .select({
          id: sessions.id,
          repo: sessions.repo,
          gitBranch: sessions.gitBranch,
          startedAt: sessions.startedAt,
          lastSeenAt: sessions.lastSeenAt,
          turns: count(turns.id),
          // 세션 안에서 쓴 모델 목록. array_agg(distinct)는 NULL도 담으므로 걸러낸다.
          models: sql<string[]>`array_remove(array_agg(distinct ${turns.model}), null)`,
          outputTokens: sumInt(turns.outputTokens),
          costUsd: totalCostUsd,
          carryUsd: carryCostUsd,
        })
        .from(sessions)
        .leftJoin(turns, eq(turns.sessionId, sessions.id))
        .leftJoin(modelPrices, eq(modelPrices.model, turns.model))
        .where(repo ? eq(sessions.repo, repo) : undefined)
        .groupBy(sessions.id)
        .orderBy(desc(sessions.lastSeenAt))
    },
  )

  // 세션 하나 + 응답 전부(시간순), 응답마다 비용.
  app.get(
    '/sessions/:id',
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: { 200: SessionDetail, 404: NotFound },
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const [session] = await db.select().from(sessions).where(eq(sessions.id, id))
      if (!session) return reply.code(404).send({ error: 'session not found' })

      const rows = await db
        .select({
          id: turns.id,
          ts: turns.ts,
          model: turns.model,
          inputTokens: turns.inputTokens,
          cacheReadTokens: turns.cacheReadTokens,
          cacheCreationTokens: turns.cacheCreationTokens,
          outputTokens: turns.outputTokens,
          sidechain: turns.sidechain,
          costUsd: turnCostUsd.mapWith((v) => (v === null ? null : Number(v))),
        })
        .from(turns)
        .leftJoin(modelPrices, eq(modelPrices.model, turns.model))
        .where(eq(turns.sessionId, id))
        .orderBy(asc(turns.ts))

      // 이 세션의 스킬 호출. turns 와 같은 시간축이라 화면에서 나란히 읽힌다.
      const skills = await db
        .select({
          id: skillInvocations.id,
          ts: skillInvocations.ts,
          skill: skillInvocations.skill,
          source: skillInvocations.source,
        })
        .from(skillInvocations)
        .where(eq(skillInvocations.sessionId, id))
        .orderBy(asc(skillInvocations.ts))

      // 도구 응답: 합계와 큰 것 몇 개. 합계를 따로 내는 이유는 top 10 만으로는
      // "이 세션이 도구 응답을 얼마나 실어 날랐나"를 알 수 없어서다.
      const [toolAgg] = await db
        .select({
          total: count(toolResults.id),
          totalBytes: sql<number>`coalesce(sum(${toolResults.bytes}), 0)::bigint`.mapWith(Number),
        })
        .from(toolResults)
        .where(eq(toolResults.sessionId, id))

      const byTool = await db
        .select({
          tool: toolResults.tool,
          count: count(toolResults.id),
          bytes: sql<number>`sum(${toolResults.bytes})::bigint`.mapWith(Number),
          maxBytes: sql<number>`max(${toolResults.bytes})::int`.mapWith(Number),
        })
        .from(toolResults)
        .where(eq(toolResults.sessionId, id))
        .groupBy(toolResults.tool)
        .orderBy(desc(sql`sum(${toolResults.bytes})`))

      const total = rows.reduce<number | null>(
        (acc, t) => (acc === null || t.costUsd === null ? null : acc + t.costUsd),
        0,
      )
      return {
        session,
        turns: rows,
        skills,
        toolResults: {
          total: toolAgg?.total ?? 0,
          totalBytes: toolAgg?.totalBytes ?? 0,
          byTool,
        },
        totalCostUsd: total,
      }
    },
  )
}
