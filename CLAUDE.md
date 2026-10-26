# agent-console

Suah's personal project. Started as a full-stack learning project; since 2026-10-12 the only goal is replacing Suah's judgment. The dashboard is the brain's scoreboard and training-data source: it observes agent-harness usage and measures how well the brain predicts Suah.

## Read First

Before any implementation or design work, read the project brain doc — it owns the plan, stack decisions (and rejected alternatives), milestones, and status:
`~/workspace/suah-brain/projects/agent-harness-dashboard/agent-harness-dashboard.md`

## Non-Negotiable Working Rules

- **Report, don't teach.** Each change is reported with what changed, why this shape, and where it fails. No mechanism lessons or grill quizzes — the learning goal closed on 2026-10-12 ("내가 배우는건 이제 끝났어").
- **Discipline deferral.** No auth, deploy pipeline, or migration ceremony until a second user exists. Local Postgres/SQLite, hardcoded token, tunnel.
- **Stack is settled.** Fastify + Drizzle keep mechanisms visible; do not introduce NestJS-style wrappers or extra abstraction layers. The NestJS port is a recorded exit strategy, not a refactor target.
- **Latest versions, within pnpm's release-age rule.** Pick the newest stable release that pnpm allows (`minimumReleaseAge` 1440 min). Never add `minimumReleaseAgeExclude` entries; if the newest version is under a day old, take the previous one or wait. `@types/node` tracks the Node major in `.nvmrc`.
- **Design rules live in `apps/web/DESIGN.md`.** Read it before touching any web UI. Tokens and classes come from `apps/web/app/globals.css`; no hex or ad-hoc styling in components.
- **Comments carry why and failure modes.** Explain why this shape over the alternatives and where it fails, with the measurement or incident behind it when there is one. No teaching comments that walk through what a block does.
- **Korean everywhere.** Code comments, in-repo docs (README, design notes), commit messages, and session reports are Korean. Commit type keywords (`feat`, `fix`, `refactor`) and identifiers stay English. The brain doc follows `suah-brain`'s own language rule (Korean 개조식).
- Commit rule: this repo overrides the global rule — commit without asking (Suah, 2026-10-26). Push still needs approval.
- After a session that changes plan, status, or decisions, update the brain doc's Status section (that repo auto-commits).
