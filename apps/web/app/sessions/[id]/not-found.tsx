import Link from 'next/link'
import { Nav } from '../../nav'

export default function SessionNotFound() {
  return (
    <main>
      <Nav />
      <h1>없는 세션이에요</h1>
      <p className="state">
        주소의 세션 ID가 DB에 없어요. <Link href="/sessions">세션 목록으로</Link>
      </p>
    </main>
  )
}
