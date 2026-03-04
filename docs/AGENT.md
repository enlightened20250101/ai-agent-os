# AGENT.md

## Working Agreement

- Build in small, vertical slices that keep the system runnable end-to-end.
- Prefer incremental commits with clear scope (one concern per commit).
- Run lint and tests before each commit.
- Keep changes minimal and production-oriented for MVP speed.
- Do not pause for open questions during implementation; make a reasonable decision and record it in `docs/decisions.md`.

## Engineering Standards

- Language/runtime: TypeScript on Next.js App Router.
- Data/auth: Supabase Postgres + Supabase Auth + RLS.
- Integration style: route handlers and server actions for backend workflows.
- Logging is first-class: every meaningful state transition writes an Event Ledger entry.
- Security baseline: least privilege for keys, server-side secret use only, auditable events for all external actions.

## Delivery Process

1. Define/confirm the smallest shippable increment.
2. Implement the vertical path.
3. Add or update tests for changed behavior.
4. Run `npm run lint` and `npm run format:check`.
5. Commit with a focused message.
6. Update docs (`README`, `docs/architecture.md`, `docs/decisions.md`) when behavior or assumptions change.

## Test and Quality Gates

- Lint must pass.
- Formatting check must pass.
- For behavior changes, add tests at the module or route level.
- If a test is deferred for speed, document it under a clearly marked `future` section in docs.
