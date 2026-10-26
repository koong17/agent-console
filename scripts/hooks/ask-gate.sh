#!/bin/sh
# Stop 훅. 에이전트가 되돌릴 수 있는 일을 "할까요?"로 묻고 멈추는 순간을 잡는다.
#
# 왜: 2026-09-01 ~ 10-12 수아의 승인 277건 중 141건이 덧붙인 말 없는 "ㅇㅇ"였고, 251건이 되돌릴 수 있는 일이었다
# (다음 단계 진행 46, 선택지 고르기 23, 커밋 18 …). PR-08 은 이미 "되돌리기 어려운 것만 묻고 나머지는 하고 보고"라고
# 말하는데, 10-06 에 PR-08 을 고친 뒤에도 불필요한 승인 비율은 오히려 올랐다. 규칙을 몰라서가 아니라 그 순간에 안 지킨다.
#
# 판정은 말 패턴이 아니라 모델(Haiku)이 한다. vr-reminder.sh 가 단어 패턴으로 "완료 보고"와 "일반 답변"을
# 못 갈라서 오탐 14/15 로 꺼진 것(2026-10-08)을 되풀이하지 않으려는 선택이다.
# 대신 비용과 지연이 생긴다. 그래서 응답 끝이 질문 꼴일 때만 모델을 부른다 — 이 거르기는 판정이 아니라
# "물어볼 가치가 있나"만 보는 값싼 문턱이다. 질문이 아닌 응답은 모델 호출 0번.
#
# 모드(ASK_GATE_MODE):
#   log   (기본, 수아 선택 2026-10-12) 판정만 harness-events.jsonl 에 남긴다. 모델 호출을 백그라운드로 돌려
#         Stop 이 기다리지 않는다 — 기록 모드에서 응답 지연을 만들 이유가 없다.
#   block (2026-10-22 부터 켬) 같은 판정을 동기로 돌리고, 되돌릴 수 있는 일을 묻고 있으면 Stop 을 막아 "하고 보고하라"고 돌려보낸다.
#         stop_hook_active 가 true 면 다시 막지 않는다 — 무한 반복 방지.
#
# 보는 범위의 한계: 산문으로 끝난 질문만 본다. AskUserQuestion 으로 낸 질문은 Stop 이 아니라 도구 호출이라
# 여기로 안 온다(그쪽은 log-decision.sh 가 decisions 로 남긴다).
# 남기는 줄: type=ask-gate, outcome = would-block | allowed | judge-failed, 그리고 판정 근거와 질문 끝부분.
# 질문 끝부분을 남기는 이유: VR 훅 판독 때 transcript 를 뒤져 원문을 찾아야 했다. 일주일 뒤 오탐을 읽을 재료다.
#
# 2026-10-22 기록 10일 판독(차단 대상 19건): 맞게 잡음 14, 애매 3, 오판 2. 오판 둘은 피드 커서 읽음 처리
#   (feed-curation 스킬이 확인 없이 커서를 못 옮기게 함)와 새 작업의 범위 확인(전역 규칙이 "불명확하면 먼저 묻는다").
#   둘을 판정 프롬프트의 예외로 넣고 block 으로 바꿨다(수아 선택). 애매 3건은 공유 MR 스레드 resolve,
#   디자인 결정이 섞인 충돌 해결, 새 티켓이 딸린 설정 수정 — 다음 판독 때 다시 본다.
#
# 2026-10-26 block 4일 판독(차단 13건): 맞게 막음 9, 오판 1, 사람 없는 세션 2, 막은 뒤 과하게 진행 1.
#   오판은 또 공유 MR 스레드 resolve(두 번째) — 남이 보는 상태를 바꾸므로 hard_to_reverse 예시에 넣었다.
#   사람 없는 세션 둘은 suah-brain 교정 재생(claude -p)이었다. 재생은 "그때 에이전트가 무엇을 했나"를 재현하는
#   실험이라, 여기서 막으면 결과가 오염된다. 그래서 무인 세션은 판정도 기록도 하지 않는다.
#   과하게 진행 1건은 막힌 뒤 추천안(선택지 3)으로 가면서 수정 하나를 더 얹었고, 수아가 "과하게 한거 아니야?"로 교정했다.
#   훅이 시킨 건 "추천안으로 진행"까지라 훅 오판은 아니다. 같은 모양이 반복되면 다시 본다.
#
# 이 파일의 실제 위치는 agent-console 레포다. ~/.claude/hooks/ask-gate.sh 는 여기로 오는 심링크.

set -u
payload=$(cat)

# 무인 세션(claude -p 등)은 건너뛴다. 답할 사람이 없고, 교정 재생처럼 원래 행동을 재현하는 실행을 바꿔 버린다.
# Claude Code 2.1.305 가 훅에 넘기는 값: 대화형 1, -p 0. 변수가 없으면(예전 버전) 지금처럼 판정한다.
[ "${CLAUDE_CODE_SESSION_ATTENDED:-1}" = 0 ] && exit 0
mode=${ASK_GATE_MODE:-log}
events=${ASK_GATE_EVENTS:-$HOME/.claude/harness-events.jsonl} # 테스트에서만 바꾼다

active=$(printf '%s' "$payload" | jq -r '.stop_hook_active // false' 2>/dev/null)
session=$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null)
msg=$(printf '%s' "$payload" | jq -r '.last_assistant_message // empty' 2>/dev/null)
[ -n "$msg" ] || exit 0

# 마지막 비어 있지 않은 8줄. 바이트로 자르면(tail -c) 한글 한 글자가 반으로 잘릴 수 있어 줄 단위로 자른다.
tail_txt=$(printf '%s\n' "$msg" | awk 'NF' | tail -n 8)
# 문턱: 끝 두 줄에 물음표나 "까요"가 없으면 질문으로 끝난 응답이 아니다.
printf '%s\n' "$tail_txt" | tail -n 2 | grep -Eq '\?|？|까요' || exit 0

judge() {
  sys='You judge the last lines of an AI coding agent message that ends with a question to the user.
Answer with one JSON object only: {"asks_permission": bool, "hard_to_reverse": bool, "kind": string, "reason": string}.
asks_permission: the agent is stopping to get approval or a choice before doing something it could do itself (continue a plan, run a job, pick among options it listed, commit, edit a file). False for questions that need a fact only the user has, and for rhetorical or reported questions.
Also false in two cases where the user wants to be asked: (1) moving a read marker or cursor ("여기까지 읽음 처리할까요?") — the user requires confirmation before it moves; (2) checking the scope or meaning of a new task before starting it ("이 범위가 맞나요?", "어떤 걸 확인하는 건가요?") — that is a missing fact, not permission.
hard_to_reverse: the action deletes data, publishes to other people (push, MR, Slack, Jira, comments, resolving a review thread, deploy), or undoes someone else'"'"'s action. Commit counts as hard_to_reverse (the user requires approval for commits).
kind: one of proceed_next_step, pick_option, paid_job, commit, push_or_publish, delete, missing_fact, other.
reason: one short sentence in Korean.'
  printf '%s' "$tail_txt" | claude -p --model haiku --no-session-persistence --setting-sources "" \
    --strict-mcp-config --tools "" --output-format json --system-prompt "$sys" 2>/dev/null \
    | jq -c '.result | capture("(?<j>\\{.*\\})"; "s").j | fromjson' 2>/dev/null
}

record() {
  verdict=$1
  if [ -z "$verdict" ]; then
    outcome=judge-failed; verdict='{}'
  elif printf '%s' "$verdict" | jq -e '.asks_permission == true and .hard_to_reverse == false' >/dev/null 2>&1; then
    outcome=$2
  else
    outcome=allowed
  fi
  jq -nc --arg s "$session" --arg c "$cwd" --arg o "$outcome" --arg m "$mode" --arg t "$tail_txt" --argjson v "$verdict" \
    '{ts: (now | floor), type: "ask-gate", session_id: $s, cwd: $c, outcome: $o, mode: $m,
      kind: ($v.kind // null), reason: ($v.reason // null), ask: ($t | .[-400:])}' >> "$events" 2>/dev/null
  echo "$outcome"
}

if [ "$mode" = block ] && [ "$active" != true ]; then
  out=$(record "$(judge)" blocked)
  if [ "$out" = blocked ]; then
    jq -n '{decision: "block", reason: "되돌릴 수 있는 일을 묻고 멈췄다(PR-08). 묻지 말고 지금 하고, 한 일과 결과를 보고한다. 선택지를 나열했다면 추천한 쪽으로 진행하고 그 이유를 한 줄로 적는다. 커밋·push·외부 게시·삭제는 계속 묻는다."}'
  fi
else
  # 기록 모드: 판정을 백그라운드 서브셸로 돌리고 바로 끝낸다. 서브셸의 입출력을 모두 /dev/null 로 돌려야
  # Claude Code 가 훅의 출력이 닫히기를 기다리지 않는다.
  ( record "$(judge)" would-block >/dev/null ) </dev/null >/dev/null 2>&1 &
fi
exit 0
