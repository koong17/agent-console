import { Type, type TSchema } from 'typebox'

// 라우트 스키마에서 공통으로 쓰는 조각.

// DB는 Date를 주고 전송은 문자열이다. Unsafe로 "TS에서는 Date도 받되 JSON Schema는 string"
// 이라고 선언한다. 직렬화기(fast-json-stringify)가 Date를 ISO 문자열로 바꿔준다.
// 덕분에 핸들러마다 toISOString()을 붙이지 않아도 된다.
export const DateTime = Type.Unsafe<Date | string>({ type: 'string', format: 'date-time' })

export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()])
