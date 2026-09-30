#!/bin/sh
# PostToolUse:AskUserQuestion 훅. 에이전트가 선택지를 내밀었을 때 Suah가 무엇을 골랐는지 남긴다.
# transcript는 30일 뒤 지워지므로 이 기록만이 그 결정의 유일한 증거가 된다.
# 원자료(raw evidence)일 뿐이다. brain 레포에는 걸러낸 판단만 들어가고 이 로그는 들어가지 않는다.
#
# 이 파일의 실제 위치는 agent-console 레포다. ~/.claude/hooks/log-decision.sh 는 여기로 오는 심링크.
# 출력 형식을 바꾸면 apps/server/src/ingest/events.ts 도 같은 커밋에서 바꾼다. 그래서 같은 레포에 둔다.
# settings.json 의 hooks.PostToolUse(matcher: AskUserQuestion) 가 이 스크립트를 부른다.

set -u

payload=$(cat)

tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$tool" = "AskUserQuestion" ] || exit 0

# 질문 하나당 한 줄(한 번의 호출에 질문이 최대 4개).
#   recommended: 라벨에 "(Recommended)", "(추천)", "(권장)" 이 붙은 선택지. 없으면 null. 여럿이면 첫 번째.
#   recommended_all: 표시가 붙은 선택지 전부. 복수 선택은 추천을 여러 개 달 수 있다(2026-09-30).
#   chosen:      tool_response.answers 를 질문 문장으로 찾은 값. 다중 선택이면 콤마로 이어진 문자열,
#                "Other" 로 직접 입력했으면 선택지에 없는 문장이 온다.
#   agreed:      단일 선택은 chosen == recommended. 복수 선택은 "추천한 것들을 전부 골랐나" —
#                chosen 을 ", " 로 나눠 recommended_all 이 모두 들어 있으면 true. 더 고른 건 상관없다.
#                추천이나 답이 없으면 null (판정 불가와 "반대함"을 구분).
#                한계: 라벨 안에 ", " 가 있으면 나눔이 틀린다. precedents.mjs 도 같은 방식으로 나눈다.
#   raw_response: chosen 을 못 찾았을 때만 응답 전체를 남겨 나중에 형식을 추적할 수 있게 한다.
#   multi_select: 복수 선택 질문이었나. 추천 없는 질문 경보가 복수 선택을 따로 센다.
printf '%s' "$payload" | jq -c '
  . as $p
  | ($p.tool_response // {}) as $resp
  | ($p.tool_input.questions // [])[]
  | . as $q
  | ($q.options // [] | map(.label)) as $labels
  | ($labels | map(select(test("\\((Recommended|추천|권장)\\)")))) as $recs
  | ($recs | .[0]) as $rec
  | (($resp.answers // {})[$q.question] // null) as $chosen
  | ($q.multiSelect // false) as $multi
  | {
      ts: (now | floor),
      type: "decision",
      session_id: ($p.session_id // "unknown"),
      cwd: ($p.cwd // ""),
      header: ($q.header // ""),
      question: $q.question,
      options: $labels,
      recommended: $rec,
      recommended_all: $recs,
      chosen: $chosen,
      agreed: (if $rec == null or $chosen == null then null
               elif $multi then (($chosen | split(", ")) as $picked | $recs | all(. as $r | $picked | index($r) != null))
               else ($chosen == $rec) end),
      raw_response: (if $chosen == null then $resp else null end),
      multi_select: $multi
    }' >> "$HOME/.claude/harness-events.jsonl" 2>/dev/null

exit 0
