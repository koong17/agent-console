const num = new Intl.NumberFormat('en-US')

// 서버는 UTC ISO 문자열을 준다. 화면은 한국 시간이다. 문자열을 slice 하면 UTC가 그대로 보인다.
// Next 서버가 어디서 돌든 같은 결과가 나오도록 시간대를 명시한다.
const TZ = 'Asia/Seoul'
const dayFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const timeFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})
const minuteFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

export const fmtNum = (n: number) => num.format(n)
export const fmtUsd = (usd: number | null) => (usd === null ? '단가 없음' : `$${usd.toFixed(2)}`)
// sv-SE 로케일은 YYYY-MM-DD, HH:mm:ss 형태를 준다. ISO와 같은 모양이라 골랐다.
export const fmtDay = (iso: string | null) => (iso ? dayFmt.format(new Date(iso)) : '-')
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso))
export const fmtMinute = (iso: string) => minuteFmt.format(new Date(iso))
