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
#   recommended: 라벨에 "(Recommended)" 또는 "(추천)" 이 붙은 선택지. 없으면 null.
#   chosen:      tool_response.answers 를 질문 문장으로 찾은 값. 다중 선택이면 콤마로 이어진 문자열,
#                "Other" 로 직접 입력했으면 선택지에 없는 문장이 온다.
#   agreed:      chosen == recommended. 둘 중 하나가 없으면 null (판정 불가와 "반대함"을 구분).
#   raw_response: chosen 을 못 찾았을 때만 응답 전체를 남겨 나중에 형식을 추적할 수 있게 한다.
printf '%s' "$payload" | jq -c '
  . as $p
  | ($p.tool_response // {}) as $resp
  | ($p.tool_input.questions // [])[]
  | . as $q
  | ($q.options // [] | map(.label)) as $labels
  | ($labels | map(select(test("\\((Recommended|추천)\\)"))) | .[0]) as $rec
  | (($resp.answers // {})[$q.question] // null) as $chosen
  | {
      ts: (now | floor),
      type: "decision",
      session_id: ($p.session_id // "unknown"),
      cwd: ($p.cwd // ""),
      header: ($q.header // ""),
      question: $q.question,
      options: $labels,
      recommended: $rec,
      chosen: $chosen,
      agreed: (if $rec == null or $chosen == null then null else ($chosen == $rec) end),
      raw_response: (if $chosen == null then $resp else null end)
    }' >> "$HOME/.claude/harness-events.jsonl" 2>/dev/null

exit 0
