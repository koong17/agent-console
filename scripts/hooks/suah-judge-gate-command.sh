#!/bin/sh
# UserPromptExpansion gate. 사용자가 판단 스킬을 "/명령"으로 직접 입력하면 PreToolUse:Skill 훅이
# 울리지 않는다(도구 호출이 없으므로). 그 경로를 여기서 잡는다.
#
# UserPromptExpansion 은 슬래시 명령(과 mcp 프롬프트)이 프롬프트로 펼쳐질 때 발동하고,
# command_name 을 그대로 준다. 그래서 프롬프트 원문을 파싱할 필요가 없다. 페이로드(2.1.x zod 스키마 확인):
#   { hook_event_name, expansion_type: "slash_command"|"mcp_prompt", command_name, command_args, prompt }
#
# 스로틀 상태(state_dir/marker)와 스킬 목록을 PreToolUse 게이트(suah-judge-gate.sh)와 공유·일치시킨다.
# 어느 한쪽이 울리면 세션 전체가 TTL 동안 재무장하므로, 한 세션에서 도구 경로와 명령 경로가 겹쳐도
# 이중 안내가 없다. 목록이 어긋나면 두 경로의 커버리지가 달라진다(의도적 중복, 공용화 후보).

set -u

payload=$(cat)

etype=$(printf '%s' "$payload" | jq -r '.expansion_type // empty' 2>/dev/null)
[ "$etype" = "slash_command" ] || exit 0

session=$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null)
# command_name 은 보통 "feature-plan" 형태지만 방어적으로 앞의 "/" 를 뗀다.
skill=$(printf '%s' "$payload" | jq -r '.command_name // empty' 2>/dev/null | sed 's#^/##')

log_gate() {
  jq -cn --arg s "$session" --arg c "$cwd" --arg k "$skill" --arg o "$1" \
    '{ts: (now | floor), type: "gate", session_id: $s, cwd: $c, skill: $k, outcome: $o}' \
    >> "$HOME/.claude/harness-events.jsonl" 2>/dev/null
}

# suah-judge-gate.sh 와 동일한 목록. 바뀌면 양쪽을 같이 고친다.
case "$skill" in
  feature-start|feature-workflow|feature-spec|feature-plan|feature-implement|\
  code-review|review|code-reviewer|product-design)
    ;;
  *)
    exit 0
    ;;
esac

ttl="${SUAH_JUDGE_GATE_TTL_SECONDS:-14400}"   # 4 hours
state_dir="${SUAH_JUDGE_GATE_STATE_DIR:-$HOME/.claude/hooks/state/suah-judge-gate}"
mkdir -p "$state_dir" 2>/dev/null || exit 0
marker="$state_dir/$session"

if [ -f "$marker" ]; then
  last=$(stat -f %m "$marker" 2>/dev/null || echo 0)
  now=$(date +%s)
  [ $((now - last)) -lt "$ttl" ] && { log_gate throttled; exit 0; }
fi
: > "$marker"
log_gate nudged

find "$state_dir" -type f -mtime +7 -delete 2>/dev/null

hours=$((ttl / 3600))

context=$(cat <<CTX
Judgment entry point: you typed the \`/$skill\` command.

Before continuing, invoke the \`suah-judge\` skill (Skill tool, skill: suah-judge) and
follow its Load Order, then carry out \`$skill\` under that judgment. suah-judge routes to
the smallest relevant document in ~/workspace/suah-brain (sense, principles, the matching
workflow) instead of loading the whole brain.

Skip only if this \`$skill\` is purely mechanical with no product or technical judgment in
it. This notice is throttled to once every ${hours}h per session.
CTX
)

# UserPromptExpansion 출력 스키마: { hookEventName, additionalContext?, suppressOriginalPrompt? }
jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptExpansion",
    additionalContext: $ctx
  }
}'
