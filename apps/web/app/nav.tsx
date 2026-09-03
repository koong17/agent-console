'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const items = [
  { href: '/', label: 'traces' },
  { href: '/usage', label: 'usage' },
  { href: '/sessions', label: 'sessions' },
]

// 현재 페이지 표시에 usePathname이 필요해서 클라이언트 컴포넌트다.
// aria-current="page"는 스크린리더용이면서 CSS 선택자로도 쓴다.
export function Nav() {
  const pathname = usePathname()
  const isCurrent = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))
  return (
    <nav className="nav">
      {items.map((it) => (
        <Link key={it.href} href={it.href} aria-current={isCurrent(it.href) ? 'page' : undefined}>
          {it.label}
        </Link>
      ))}
    </nav>
  )
}
