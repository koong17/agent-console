import type { ReactNode } from 'react'

export const metadata = { title: 'agent-console' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: 'ui-monospace, monospace', margin: 24 }}>{children}</body>
    </html>
  )
}
