import Link from 'next/link'

export function Nav() {
  return (
    <nav style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
      <Link href="/">traces</Link>
      <Link href="/usage">usage</Link>
    </nav>
  )
}
