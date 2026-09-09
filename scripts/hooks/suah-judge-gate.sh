#!/bin/sh
# PreToolUse:Skill gate.
# When a workflow skill that implies a judgment call is invoked, tell the model to
# route through suah-judge first. Throttled per session with a time-to-live so a long
# session re-arms instead of getting one nudge at the very first step.

set -u

payload=$(cat)

skill=$(printf '%s' "$payload" | jq -r '.tool_input.skill // empty' 2>/dev/null)
session=$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null)

# 게이트가 울린 사실을 남긴다. 마커 파일은 mtime만 있고 7일 뒤 지워져서
# 대시보드 재료로 쓸 수 없다. 스킬 호출 로그와 같은 jsonl에 type=gate로 쌓는다.
log_gate() {
  jq -cn --arg s "$session" --arg c "$cwd" --arg k "$skill" --arg o "$1" \
    '{ts: (now | floor), type: "gate", session_id: $s, cwd: $c, skill: $k, outcome: $o}' \
    >> "$HOME/.claude/harness-events.jsonl" 2>/dev/null
}

# Entry points where a judgment call is still ahead. Deliberately excludes
# creating-mr / creating-commits: by then the decisions are already made.
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

# Prune markers older than 7 days so the state dir does not grow forever.
find "$state_dir" -type f -mtime +7 -delete 2>/dev/null

hours=$((ttl / 3600))

context=$(cat <<CTX
Judgment entry point: the \`$skill\` skill was just invoked.

Before continuing, invoke the \`suah-judge\` skill (Skill tool, skill: suah-judge) and
follow its Load Order, then carry out \`$skill\` under that judgment. suah-judge routes to
the smallest relevant document in ~/workspace/suah-brain (sense, principles, the matching
workflow) instead of loading the whole brain.

Skip only if this \`$skill\` call is purely mechanical with no product or technical
judgment in it. This notice is throttled to once every ${hours}h per session.
CTX
)

jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'
