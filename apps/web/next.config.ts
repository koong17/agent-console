import type { NextConfig } from 'next'

const config: NextConfig = {
  // Next 16은 dev 시작 시 apps/web에 AGENTS.md/CLAUDE.md를 자동 생성한다.
  // 이 레포의 규칙은 루트 CLAUDE.md 하나가 소유하므로 생성을 끈다.
  agentRules: false,
}

export default config
