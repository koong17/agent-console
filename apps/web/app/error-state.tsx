import { Nav } from './nav'

// 서버(Fastify)에서 데이터를 못 받았을 때의 페이지. DESIGN.md 5절 "서버 다운".
// 각 페이지의 catch에서 이걸 돌려준다. Next의 error.tsx(에러 바운더리) 대신 페이지 안에서
// 처리하는 이유: 바운더리는 클라이언트 컴포넌트여야 하고 Nav/제목 같은 페이지 뼈대를 잃는다.
// 여기서는 "어느 페이지에서 무엇이 실패했는지"가 보이는 게 더 중요하다.
export function ErrorState({ title, error }: { title: string; error: unknown }) {
  return (
    <main>
      <Nav />
      <h1>{title}</h1>
      <p className="state-error">
        서버에서 데이터를 못 받았어요. Fastify(4000)와 Postgres가 켜져 있는지 확인하세요.
      </p>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
    </main>
  )
}
