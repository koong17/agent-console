#!/bin/sh
# 계약 파일이 서버 코드와 일치하는지 검사한다.
# 스펙을 다시 만든 뒤 packages/contract 에 변경이 생기면 "뒤처져 있었다"는 뜻이다.
set -e

pnpm -s contract >/dev/null

if ! git diff --quiet -- packages/contract; then
  echo ""
  echo "packages/contract 가 서버 코드보다 뒤처져 있었습니다. 지금 다시 생성했습니다."
  echo "변경된 파일:"
  git diff --stat -- packages/contract | sed 's/^/  /'
  echo ""
  echo "다음을 실행하고 다시 커밋하세요:"
  echo "  git add packages/contract"
  exit 1
fi

echo "contract: 최신"
