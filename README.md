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
- `SLACK_APPROVAL_CHANNEL_ID`
- `APP_BASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_SENDER_EMAIL`
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

## Slack Approval Setup

1. Create a Slack app and add OAuth scopes:
   - `chat:write`
   - `commands` (optional if slash commands are added later)
2. Enable Interactivity and set Request URL to:
   - `${APP_BASE_URL}/api/slack/actions`
3. Install the app and set env vars:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_APPROVAL_CHANNEL_ID`
4. Open `/app/integrations/slack` and use "Send test message" to verify.

## Connector Configuration (Org-Scoped)

- Primary runtime config source is `connector_accounts` per org:
  - Slack config in `/app/integrations/slack`
  - Google config in `/app/integrations/google`
- Env vars remain fallback for local/dev when no org connector record exists.
- MVP stores `connector_accounts.secrets_json` as plain JSON (`future`: encrypted secret storage).

## Google OAuth Setup

1. In Google Cloud Console, configure OAuth consent and create a Web OAuth client.
2. Set env vars:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `APP_BASE_URL` (use your HTTPS ngrok URL for local testing if needed)
3. Add redirect URI:
   - `${APP_BASE_URL}/api/google/callback`
4. In app, open `/app/integrations/google` and click `Connect Google`.
5. After consent, the org connector stores:
   - `refresh_token` in `connector_accounts.secrets_json`
   - sender email as `external_account_id` and `secrets_json.sender_email`

Notes:
- `GOOGLE_CLIENT_SECRET` is server-only and never stored in DB.
- Legacy env fallback (`GOOGLE_REFRESH_TOKEN`, `GOOGLE_SENDER_EMAIL`) remains supported for local/dev.
- OAuth `state` is stored server-side in Supabase (`google_oauth_states`) for replay-safe, cross-domain reliability (works with ngrok/local domain changes).

## Documentation

- [Working rules](docs/AGENT.md)
- [Decision log](docs/decisions.md)
- [Architecture](docs/architecture.md)
