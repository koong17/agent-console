# agent-console

Suah's personal full-stack learning project. The dashboard observes agent-harness usage; milestone 1 is the app observing itself.

## Read First

Before any implementation or design work, read the project brain doc — it owns the plan, stack decisions (and rejected alternatives), milestones, and status:
`~/workspace/suah-brain/projects/agent-harness-dashboard/agent-harness-dashboard.md`

## Non-Negotiable Working Rules

- **Explained implementation.** Agents write the code, but every change lands with a mechanism explanation: what was done, why this shape over the alternatives, and where it fails. Progress is discussion-driven — one unit at a time, never batch delivery. Suah's understanding is the deliverable; the code is the byproduct.
- **Grill checks at milestones.** Pose scenario questions to verify the mechanism landed ("two concurrent requests hit this endpoint — what happens?"). Leave open questions in the session, not buried in code comments.
- **Discipline deferral.** No auth, deploy pipeline, or migration ceremony until a second user exists. Local Postgres/SQLite, hardcoded token, tunnel.
- **Learning stack is deliberate.** Fastify + Drizzle keep mechanisms visible; do not introduce NestJS-style wrappers or extra abstraction layers. The NestJS port is a recorded exit strategy, not a refactor target.
- **Plain language.** Suah is learning backend here; assume no prior knowledge of a mechanism. One concept per paragraph, plain words before any term, define each new term inline, show what she would observe before explaining why. Terse register hurts here; clarity beats brevity.
- **Latest versions.** Pick the newest stable release of every library when adding or bumping (check `npm view <pkg> version`). `@types/node` tracks the Node major in `.nvmrc`.
- **Design rules live in `apps/web/DESIGN.md`.** Read it before touching any web UI. Tokens and classes come from `apps/web/app/globals.css`; no hex or ad-hoc styling in components.
- **Korean everywhere.** This is Suah's learning repo: code comments, in-repo docs (README, design notes), commit messages, and in-session mechanism explanations are all Korean. Commit type keywords (`feat`, `fix`, `refactor`) and identifiers stay English. The brain doc in `suah-brain` stays English (that repo's own rule).
- Commit rule: this repo follows the global rule — never commit without Suah's explicit approval.
- After a session that changes plan, status, or decisions, update the brain doc's Status section (that repo auto-commits).
