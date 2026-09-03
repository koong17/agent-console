import type { ReactNode } from 'react'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'

export const metadata = { title: 'agent-console' }

// next/font는 폰트 파일을 빌드에 포함하고 CSS 변수(--font-geist-sans, --font-geist-mono)로 노출한다.
// 외부 요청이 없어 레이아웃 흔들림(FOUT)이 없다.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <div className="page">{children}</div>
      </body>
    </html>
  )
}
