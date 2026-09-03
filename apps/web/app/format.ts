const num = new Intl.NumberFormat('en-US')

export const fmtNum = (n: number) => num.format(n)
export const fmtUsd = (usd: number | null) => (usd === null ? '단가 없음' : `$${usd.toFixed(2)}`)
export const fmtDay = (iso: string | null) => (iso ? iso.slice(0, 10) : '-')
export const fmtTime = (iso: string) => iso.slice(11, 19)
