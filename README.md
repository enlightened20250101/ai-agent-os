# AI Agent OS (MVP Wedge)

AI Agent OS is an audit-first workflow wedge:

Slack task intake -> LLM drafts -> policy check -> Slack approval -> Gmail send -> event ledger -> Evidence Pack (HTML).

## Tech Stack

- Next.js (App Router) + TypeScript
- Supabase Postgres + Supabase Auth + RLS
- Slack connector (intake + approval)
- Gmail connector (send)

## Setup

1. Install Node.js 20+.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create `.env.local` from your own values (see env list below).
4. Run development server:
   ```bash
   npm run dev
   ```

## Environment Variables

Set these in `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `OPENAI_API_KEY`
- `ALLOWED_EMAIL_DOMAINS` (optional, comma-separated allowlist for policy check)
- `E2E_PASSWORD` (for Playwright signup/login test account)
- `E2E_CLEANUP_TOKEN` (required to authorize test cleanup endpoint)

## Scripts

- `npm run dev`: start Next.js dev server
- `npm run build`: production build
- `npm run start`: run built app
- `npm run lint`: run ESLint
- `npm run typecheck`: run TypeScript type checks
- `npm run test:e2e`: run Playwright end-to-end tests
- `npm run test`: run full quality gate (`lint` + `typecheck` + `test:e2e`)
- `npm run format`: run Prettier write
- `npm run format:check`: run Prettier check

## MVP Demo Path

1. User submits a task from Slack.
2. System creates a work item and logs intake event.
3. LLM produces an email draft and logs draft event.
4. Policy engine evaluates draft and logs pass/fail details.
5. If passed, approval request is posted to Slack.
6. Approver clicks approve in Slack.
7. System sends Gmail message and logs send result.
8. Operator opens Evidence Pack HTML page showing full event timeline.

## Documentation

- [Working rules](docs/AGENT.md)
- [Decision log](docs/decisions.md)
- [Architecture](docs/architecture.md)
