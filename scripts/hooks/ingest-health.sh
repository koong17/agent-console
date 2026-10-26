#!/bin/sh
# SessionStart 훅. 수집(ingest)이 연속으로 실패하고 있으면 세션 첫 답에서 수아에게 알리게 한다.
#
# 왜: 2026-10-08 ~ 10-26 수집이 328번 연속 failed 였는데 18일 동안 아무도 몰랐다. 실패는 ingest_runs 에
# 꼬박꼬박 기록됐지만 그걸 보는 화면(/ingest)을 아무도 열지 않았다. 대시보드는 열어야 보이고, 세션은 매일 시작한다.
# 그래서 경보를 수아가 실제로 보는 자리(세션 첫 답)로 옮긴다.
#
# 왜 서버 API(/ingest/status)가 아니라 psql 인가: 서버가 꺼져 있어도 실패 기록은 DB 에 남아 있고, psql 은 수십 ms 라
# 매 세션 시작마다 내도 부담이 없다. tsx 로 TS 를 띄우면 1초 넘게 든다.
#
# 보는 것: 마지막 성공(done) 이후의 failed 수. 주기가 1시간이라 3이면 세 시간째 실패 중이다.
# 한 번 실패는 재시작 중 끊김(process restarted mid-run) 같은 정상 잡음이라 울리지 않는다.
# 안 보는 것: unexplained(형식 드리프트)는 성공한 실행 안의 숫자라 /ingest 화면 몫이다. 서버가 아예 꺼져서
# 실행 자체가 없는 경우도 못 잡는다 — 그건 실패가 아니라 정지라, 기록이 남지 않는다.
#
# 이 파일의 실제 위치는 agent-console 레포다. ~/.claude/hooks/ingest-health.sh 는 여기로 오는 심링크.

cat >/dev/null
# 무인 세션(claude -p)은 알릴 사람이 없다.
[ "${CLAUDE_CODE_SESSION_ATTENDED:-1}" = 0 ] && exit 0

db=${INGEST_HEALTH_DB:-postgres://localhost:5432/agent_console} # 테스트에서만 바꾼다
min=${INGEST_HEALTH_MIN:-3}

# DB 가 없거나 꺼져 있으면 조용히 끝낸다. 세션 시작을 막을 이유가 없다.
row=$(PGCONNECT_TIMEOUT=2 psql "$db" -XAt -F '|' -c "
  select count(*), max(started_at)::timestamp(0), (array_agg(left(coalesce(error, ''), 160) order by id desc))[1]
  from ingest_runs
  where status = 'failed' and id > coalesce((select max(id) from ingest_runs where status = 'done'), 0)
" 2>/dev/null) || exit 0

count=${row%%|*}
[ -n "$count" ] && [ "$count" -ge "$min" ] 2>/dev/null || exit 0
rest=${row#*|}
last=${rest%%|*}
error=${rest#*|}

echo "agent-console ingest has failed $count times in a row since its last success (latest failure $last, error: $error). Start your first reply by telling Suah this in one Korean sentence, and offer to find the cause (pnpm ingest in ~/workspace/agent-console/apps/server reproduces it)."
