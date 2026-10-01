// 질문 종류 분류 결과를 파일로 내보낸다. suah-brain 의 scripts/precedents.mjs --semantic 이 읽는다.
//
// DB 를 직접 읽게 하지 않고 파일로 두는 이유: precedents.mjs 는 에이전트가 질문하기 직전에 부르는
// 스크립트라 서버나 Postgres 가 꺼져 있어도 돌아야 한다. 입력인 harness-events.jsonl 과 같은 자리
// (~/.claude)에 같은 모양(평범한 JSON)으로 둔다. 파일이 없거나 낡으면 precedents 는 예전 방식
// (글자 겹침)으로 돌아간다 — 분류가 늦게 따라와도 판단이 멈추지 않는다.
//
// 키는 (session_id, 초 단위 ts, question). 훅이 남긴 원본 줄을 그대로 가리키는 자연 키다.
import { writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { decisionKinds, decisionPolicies, decisions, questionKinds } from '../db/schema.js'
import { graduationReport } from '../scoreboard.js'

export const KINDS_FILE = process.env.QUESTION_KINDS_FILE ?? join(homedir(), '.claude', 'question-kinds.json')

export async function exportKinds(path = KINDS_FILE) {
  const kinds = await db.select({ name: questionKinds.name, description: questionKinds.description }).from(questionKinds)
  const rows = await db
    .select({
      sessionId: decisions.sessionId,
      ts: decisions.ts,
      question: decisions.question,
      kind: decisionKinds.kind,
      policy: decisionPolicies.policy,
    })
    .from(decisionKinds)
    .innerJoin(decisions, eq(decisions.id, decisionKinds.decisionId))
    // 답 정책(answer-policy)이 있으면 같이 싣는다. precedents 는 정책이 있으면 답 라벨 대신 정책으로 settled 를 판정한다.
    .leftJoin(decisionPolicies, eq(decisionPolicies.decisionId, decisions.id))
  // 졸업한 종류. precedents 는 이 목록의 종류를 "묻지 말고 답한 뒤 보고"로 낸다.
  const graduated = (await graduationReport()).kinds.filter((k) => k.graduated).map((k) => k.kind)
  const body = {
    generatedAt: new Date().toISOString(),
    graduated,
    kinds: Object.fromEntries(kinds.map((k) => [k.name, k.description])),
    decisions: rows.map((r) => ({
      session_id: r.sessionId,
      ts: Math.floor(r.ts.getTime() / 1000),
      question: r.question,
      kind: r.kind,
      policy: r.policy,
    })),
  }
  // 임시 파일에 쓰고 이름을 바꾼다. precedents 가 쓰는 도중의 반쪽 파일을 읽지 않게 한다 —
  // rename 은 같은 디스크 안에서 한 번에 일어난다.
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(body))
  await rename(tmp, path)
  return body.decisions.length
}
