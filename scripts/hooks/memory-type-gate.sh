#!/usr/bin/env bash
# PreToolUse(Write|Edit) gate: corrections and preferences (type: feedback | user) do not belong in
# Claude Code project memory (~/.claude/projects/*/memory). They go to suah-brain inbox.md through the
# memory-save skill. Project memory keeps repo-specific facts only (type: project | reference).
#
# Why a hook and not a rule: the rule existed in CLAUDE.md and in project memory itself and was still
# violated on 2026-09-14 — the harness system prompt that says "write to project memory" is closer at the
# moment of saving than any document. See suah-brain decisions/2026-06-26-forcing-function-over-documentation.md.
set -u
payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
session=$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null)

case "$path" in
  "$HOME"/.claude/projects/*/memory/*.md) ;;
  *) exit 0 ;;
esac

# Write carries the whole file; Edit carries only the inserted text.
if [ "$tool" = "Write" ]; then
  body=$(printf '%s' "$payload" | jq -r '.tool_input.content // empty' 2>/dev/null)
else
  body=$(printf '%s' "$payload" | jq -r '.tool_input.new_string // empty' 2>/dev/null)
fi

if ! printf '%s' "$body" | grep -qE '^[[:space:]]*type:[[:space:]]*(feedback|user)[[:space:]]*$'; then
  exit 0
fi

jq -cn --arg s "$session" --arg c "$cwd" --arg p "$path" --arg t "$tool" \
  '{ts: (now | floor), type: "memory-deny", session_id: $s, cwd: $c, tool: $t, path: $p}' \
  >> "$HOME/.claude/harness-events.jsonl" 2>/dev/null

reason='교정·선호(type: feedback | user)는 프로젝트 메모리에 쓰지 않는다. 일반화한 판단 한 줄은 ~/workspace/suah-brain/inbox.md 에 (memory-save 스킬, 승인 불필요), 레포 고유 사실은 type: project 로 다시 쓴다. 라벨만 바꿔 우회하지 말 것 — 내용이 판단·선호면 inbox 다.'
jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
