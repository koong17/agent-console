#!/bin/sh
# DESIGN.md 7절 중 기계적으로 검사할 수 있는 두 규칙을 확인한다.
#   1. 컴포넌트에 hex 색을 직접 쓰지 않는다. 색은 globals.css 의 변수만.
#   2. 인라인 style 은 데이터에 따라 바뀌는 값(막대 폭·높이)에만. 즉 className="bar" 요소에만.
# 문서에만 있는 규칙은 어겨도 아무도 모른다. 그래서 grep 한 줄이라도 코드로 둔다.
# 주관적 규칙(위계, 톤)은 여기서 검사하지 않는다. 그건 DESIGN.md 산문의 몫.

status=0

# \b 로 끝을 막아 더 긴 토큰은 빼고, 앵커(href="#top")는 0-9a-f 만으로 이뤄지지 않아 대부분 빠진다.
hex=$(grep -rnE '#[0-9a-fA-F]{3,8}\b' --include='*.tsx' apps/web/app || true)
if [ -n "$hex" ]; then
  echo "design: 컴포넌트에 hex 색이 있습니다. var(--token) 으로 바꾸세요."
  echo "$hex" | sed 's/^/  /'
  status=1
fi

# prettier 가 긴 JSX 속성을 줄바꿈하므로 줄 단위 grep 은 못 쓴다.
# 파일 전체를 한 문자열로 읽고, style= 앞 같은 태그 안('<' 이후)에 className="bar" 가 있는지 본다.
inline=$(find apps/web/app -name '*.tsx' -exec perl -0777 -ne '
  while (/style=/g) {
    my $before = substr($_, 0, pos($_));
    my $tag = substr($before, rindex($before, "<"));
    next if $tag =~ /className="bar"/;
    my $line = ($before =~ tr/\n//) + 1;
    print "$ARGV:$line\n";
  }
' {} + || true)
if [ -n "$inline" ]; then
  echo "design: 막대(.bar) 밖에서 인라인 style 을 썼습니다. globals.css 클래스로 옮기세요."
  echo "$inline" | sed 's/^/  /'
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "design: 통과"
fi
exit "$status"
