'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// 서버 컴포넌트는 스스로 다시 실행될 수 없다. 브라우저에서 돌아가는 이 조각이
// 주기적으로 router.refresh()를 호출해 서버 컴포넌트 트리를 다시 요청한다.
// 페이지 전체 리로드가 아니라 RSC 페이로드만 다시 받아 그 자리에서 교체된다.
export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(id)
  }, [router, intervalMs])

  return null
}
