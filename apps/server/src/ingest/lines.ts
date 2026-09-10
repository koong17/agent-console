import { createReadStream } from 'node:fs'

// JSONL 파일을 줄 단위로 흘려 읽는다.
//
// 왜 node:readline 을 안 쓰나. readline 은 줄 끝을 \n 만으로 보지 않는다.
// \r 과 U+2028(LINE SEPARATOR)에서도 끊는다. 그런데 U+2028 은 JSON 문자열 안에
// 리터럴로 들어가도 문법에 맞고, Claude Code 가 실제로 그렇게 쓴다.
// 그래서 유효한 JSON 한 줄이 두 조각으로 잘리고, 두 조각 다 파싱에 실패해 버려졌다.
// 2026-09-10 계측으로 확인: 22개 파일에서 388줄이 이렇게 통째로 사라지고 있었다.
//
// JSONL 에서 한 줄의 정의는 "\n 까지"다. 그 정의를 라이브러리에 맡기지 않고 직접 쓴다.
//
// 남는 한계: CRLF 파일이면 줄 끝에 \r 이 붙어 온다. JSON 문법에서 \r 은 공백이라
// JSON.parse 가 그냥 무시하므로 따로 떼지 않는다. 트랜스크립트에 CRLF 는 없었다(측정함).
export async function* readLines(path: string): AsyncGenerator<string> {
  // encoding 을 주면 스트림이 StringDecoder 를 쓴다. 여러 바이트짜리 글자가
  // 청크 경계에 걸려도 쪼개지지 않는다. 이걸 안 주면 한글이 깨진다.
  const stream = createReadStream(path, { encoding: 'utf8' })
  let buf = ''
  for await (const chunk of stream) {
    buf += chunk
    let i: number
    // 버퍼는 청크 하나(기본 64KB) + 걸쳐 있는 줄 하나 크기를 넘지 않는다.
    // 그래서 slice 를 반복해도 복사량이 파일 크기에 비례해 커지지 않는다.
    while ((i = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, i)
      buf = buf.slice(i + 1)
    }
  }
  // 마지막 줄에 \n 이 없는 경우(쓰는 중인 파일). 빈 꼬리는 줄로 치지 않는다.
  if (buf.length > 0) yield buf
}
