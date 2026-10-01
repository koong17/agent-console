#!/bin/sh
# Stop 훅. 에이전트가 "끝났다"고 말하는 순간에 검증 규칙(VR)을 다시 들이민다.
#
# 왜: 2026-09-30 교정 되짚기에서 규칙 무시 74건 중 21건이 검증 규칙이었다. 그 21건 전부 완료 보고
# 문서(verification-reporting.md)를 안 읽었고, sense.md 는 교정 시점보다 평균 120턴 앞에 읽혀 있었다.
# 규칙이 틀린 게 아니라 읽힌 때가 틀렸다. 그래서 "완료 주장" 순간으로 규칙을 옮긴다.
#
# 모드(VR_REMINDER_MODE):
#   log   (기본) 판정만 harness-events.jsonl 에 남긴다. 막지 않는다. 오탐이 얼마나 되는지 먼저 본다.
#   block 완료 주장인데 검증 여부를 밝히지 않았으면 Stop 을 막고 VR 요약을 되돌려 준다.
#         에이전트는 한 턴 더 돌아 검증하거나 "검증한 것/못 한 것"을 밝힌다.
# block 은 stop_hook_active 가 true 면(이미 한 번 막은 뒤면) 다시 막지 않는다 — 무한 반복 방지.
#
# 판정:
#   claim     완료를 말하는 표현이 있다(완료, 끝났, 고쳤, 통과, done ...)
#   disclosed 검증 여부를 밝히는 표현도 있다(검증한 것, 확인 못, 미검증, unverified ...)
#   → claim 이고 disclosed 가 아니면 would-block(log) / blocked(block). claim 이고 disclosed 면 disclosed.
# 한계: 말로 가른다. "통과했"이 들어간 질문 답변이나 인용도 claim 으로 잡힌다. log 모드가 그 비율을 재는 단계다.
#
# 2026-10-01 패턴 보강(기록 11건 중 would-block 8건을 읽은 결과, 수아가 "기록 모드 유지, 패턴만 보강"을 고름):
#   - "완료"는 앞에 한글이 붙지 않을 때만 claim. 버튼 이름 "지급완료"가 섞인 조사 보고가 잡혔다.
#   - disclosed 에 긍정 표현("확인했", "검증했", "통과 확인")도 넣는다. 원래는 "못 했다"류 부정 표현만 찾아서,
#     검증을 하고 그렇게 적은 보고 2건을 would-block 으로 셌다. 규칙의 요구는 "한 것/못 한 것을 밝힌다"이므로 둘 다 밝힘이다.
#   - "확인은 안 했어"처럼 조사가 끼는 부정형을 못 잡았다. "확인(은|도|을)? 안 (했|함)" 꼴을 넣는다.
#   측정 기준이 바뀌었으므로 이 날짜 전후 비율은 따로 본다.
#
# 이 파일의 실제 위치는 agent-console 레포다. ~/.claude/hooks/vr-reminder.sh 는 여기로 오는 심링크.
# 남기는 줄의 type 은 apps/server/src/ingest/events.ts 가 예상된 type 으로 센다.

set -u
payload=$(cat)
mode=${VR_REMINDER_MODE:-log}

active=$(printf '%s' "$payload" | jq -r '.stop_hook_active // false' 2>/dev/null)
msg=$(printf '%s' "$payload" | jq -r '.last_assistant_message // empty' 2>/dev/null)
# 예전 버전은 last_assistant_message 를 안 줄 수 있다. 그때는 transcript 의 마지막 에이전트 글을 읽는다.
if [ -z "$msg" ]; then
  tp=$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)
  [ -n "$tp" ] && [ -f "$tp" ] && msg=$(tail -n 400 "$tp" | jq -rs '[.[] | select(.type=="assistant" and (.isSidechain|not)) | .message.content[]? | select(.type=="text") | .text] | last // empty' 2>/dev/null)
fi
[ -n "$msg" ] || exit 0

claim=$(printf '%s' "$msg" | grep -Eiq '(^|[^가-힣])완료|끝났|끝냈|마쳤|고쳤|통과했|다 됐|구현했|반영했|push 했|푸시했|\bdone\b|completed|\bfixed\b|implemented' && echo 1 || echo 0)
[ "$claim" = 1 ] || exit 0
disclosed=$(printf '%s' "$msg" | grep -Eiq '검증한 것|검증 안 한|검증하지 못|확인하지 못|확인 못|확인(은|도|을)? 안 (했|함)|검증(은|도|을)? 안 (했|함)|미검증|검증 안 됨|못 봤|확인했|검증했|확인한 것|돌려 봤|verified|unverified|not verified|did not verify' && echo 1 || echo 0)

if [ "$disclosed" = 1 ]; then outcome=disclosed
elif [ "$mode" = block ] && [ "$active" != true ]; then outcome=blocked
else outcome=would-block
fi

printf '%s' "$payload" | jq -c --arg outcome "$outcome" --arg mode "$mode" '{
  ts: (now | floor), type: "vr-reminder", session_id: (.session_id // "unknown"), cwd: (.cwd // ""),
  outcome: $outcome, mode: $mode
}' >> "$HOME/.claude/harness-events.jsonl" 2>/dev/null

if [ "$outcome" = blocked ]; then
  jq -n '{decision: "block", reason: "완료를 말하기 전에 검증 규칙을 다시 본다(VR-01, VR-03, VR-04). 실제로 돌려 본 것(화면 렌더, 런타임 상태, 원격 상태)과 못 본 것을 두 부분으로 나눠 밝힌다. 못 본 것이 확인 가능하면 지금 확인한다. 기억이나 추측으로 채운 사실이 있으면 확인하거나 추측이라고 적는다."}'
fi
exit 0
