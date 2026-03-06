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
- `SLACK_ALERTS_CHANNEL_ID` (optional; ops alert channel, fallback to approval channel)
- `SLACK_INTAKE_CHANNEL_ID` (optional; Slack task intake target channel, fallback to approval channel)
- `SLACK_DEFAULT_ORG_ID` (optional; env-only Slack modeのorg解決用)
- `ENABLE_OPS_SLACK_ALERTS` (`1` to enable threshold-based ops alerts)
- `OPS_ALERT_CONSECUTIVE_FAIL_THRESHOLD` (default `2`)
- `APP_BASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_SENDER_EMAIL`
- `PLANNER_RUN_TOKEN`
- `MONITOR_RUN_TOKEN` (optional; if unset in cron workflow, uses `PLANNER_RUN_TOKEN`)
- `EVENTS_INGEST_TOKEN` (optional in dev, required in non-dev for `/api/events/intake` token auth)
- `EVENTS_AUTOMATION_TOKEN` (optional; `/api/events/auto-caseify` token, fallback to `PLANNER_RUN_TOKEN`)
- `MONITOR_STALE_HOURS` (default `6`; monitor stale threshold, fallback to planner stale hours)
- `MONITOR_CHAT_NUDGE_ENABLED` (`1` default; monitor signal detection posts system nudge to shared chat)
- `MONITOR_RECOVERY_COOLDOWN_SECONDS` (default `90`; cooldown for `@AI 監視回収を実行` to avoid duplicate burst runs)
- `MONITOR_RECOVERY_WORKFLOW_RETRY_PASSES` (default `1`; extra retry passes for workflow failures during monitor recovery)
- `GOVERNANCE_HIGH_RISK_THRESHOLD` (default `70`; risk score threshold requiring two-person approval)
- `GOVERNANCE_HOURLY_SEND_EMAIL_LIMIT` (default `10`; rolling 1-hour success cap for google/send_email)
- `MONITOR_RECOVERY_EXCEPTION_AUTO_CREATE` (default `1`; auto upsert exception cases for manual workflow failures)
- `MONITOR_RECOVERY_EXCEPTION_SLA_HOURS` (default `8`; due SLA hours for auto-created exception cases)
- `WORKFLOW_FAILURE_EXCEPTION_AUTO_CREATE` (default `1`; auto upsert failed_workflow exception case on workflow run failure)
- `WORKFLOW_FAILURE_EXCEPTION_SLA_HOURS` (default `8`; due SLA hours for workflow failure exception cases)
- `GOV_RECOMMENDATIONS_TOKEN` (optional; if unset, endpoint uses `PLANNER_RUN_TOKEN`)
- `WORKFLOW_TICK_TOKEN` (optional; if unset, endpoint uses `PLANNER_RUN_TOKEN`)
- `INCIDENT_AUTOMATION_TOKEN` (optional; if unset, endpoint uses governance/planner token)
- `INCIDENT_AUTO_OPEN_ENABLED` (`1` to enable auto incident opening)
- `INCIDENT_AUTO_FAIL_THRESHOLD` (default `3`, consecutive planner/review failures)
- `INCIDENT_AUTO_ACTION_FAILED_THRESHOLD` (default `5`, failed actions in lookback)
- `INCIDENT_AUTO_LOOKBACK_HOURS` (default `6`)
- `EXCEPTION_ALERTS_TOKEN` (optional; fallback to incident/governance/planner token)
- `APPROVAL_REMINDER_TOKEN` (optional; fallback to exception/incident/governance/planner token)
- `CHAT_CONFIRMATIONS_TOKEN` (optional; fallback to approval/exception/incident/governance/planner token)
- `EXCEPTION_EXPORT_TOKEN` (optional; enables server-to-server exception export API access)
- `CHAT_EXPORT_TOKEN` (optional; enables server-to-server chat audit export API access)
- `EXCEPTION_ALERT_COOLDOWN_MINUTES` (default `60`)
- `OPS_JOB_RETRY_MAX_ATTEMPTS` (default `2`, max per-org attempt count for batch APIs)
- `OPS_JOB_RETRY_BACKOFF_MS` (default `500`, linear backoff base milliseconds)
- `OPS_JOB_CIRCUIT_BREAKER_THRESHOLD` (default `3`, consecutive exhausted runs before opening per-job circuit)
- `OPS_JOB_CIRCUIT_BREAKER_PAUSE_MINUTES` (default `30`, pause duration while a job circuit stays open)
- `OPS_JOB_CIRCUIT_DRY_RUN_MINUTES` (default `10`, probe window before full resume)
- `OPS_JOB_CIRCUIT_RECHECK_MINUTES` (default `15`, re-check interval when resume gate is not met)
- `OPS_JOB_CIRCUIT_MIN_SUCCESS_RATE` (default `0.6`, recent recovered/(recovered+exhausted) gate)
- `OPS_JOB_CIRCUIT_MIN_SAMPLE_SIZE` (default `5`, minimum sample size for success-rate gate)
- `EXCEPTION_ESCALATION_HOURS_L1` (default `2`, medium escalation threshold)
- `EXCEPTION_ESCALATION_HOURS_L2` (default `8`, high escalation threshold)
- `EXCEPTION_ESCALATION_HOURS_L3` (default `24`, critical escalation threshold)
- `OPENAI_API_KEY`
- `ALLOWED_EMAIL_DOMAINS` (optional, comma-separated allowlist for policy check)
- `E2E_PASSWORD` (for Playwright signup/login test account)
- `E2E_CLEANUP_TOKEN` (required to authorize test cleanup endpoint)
- `EXCEPTION_PENDING_APPROVAL_HOURS` (exception queue stale approval threshold; default `6`)
- `APPROVAL_REMINDER_STALE_HOURS` (optional; pending承認の再通知対象しきい値。未設定時は `EXCEPTION_PENDING_APPROVAL_HOURS`)
- `APPROVAL_REMINDER_COOLDOWN_MINUTES` (default `120`; 同一approvalへの再通知クールダウン)
- `APPROVAL_REMINDER_MAX_TARGETS` (default `20`; 1回のジョブで処理する最大件数)
- `APPROVAL_REMINDER_AUTO_MIN_STALE` (default `3`; 自動再通知ジョブ実行の最小 stale pending 件数)
- `CHAT_DAILY_EXECUTION_LIMIT` (default `30`; ユーザー単位の1日あたりチャット実行上限)

## Scripts

- `npm run dev`: start Next.js dev server
- `npm run build`: production build
- `npm run start`: run built app
- `npm run lint`: run ESLint
- `npm run typecheck`: run TypeScript type checks
- `npm run test:e2e`: run Playwright end-to-end tests
- `npm run test`: run full quality gate (`lint` + `typecheck` + `test:e2e`)
- `npm run export:exceptions -- --org-id=<org_uuid> [--out=./out.json]`: paginated JSON export helper
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
9. Evidence Pack includes exception case state and exception_case_events audit trail when the task has exception records.

## Autonomous Planner (MVP)

- UI:
  - `/app/planner` to run planner now and inspect recent runs.
  - `/app/proposals` to accept/reject autonomous proposals.
- Trigger endpoint:
  - `POST /api/planner/run?org_id=<org_uuid>`
  - `POST /api/planner/run` (all orgs, optional `max_orgs` query; for cron/batch)
  - Auth:
    - `NODE_ENV=development` allows local testing.
    - otherwise requires header `x-planner-token: ${PLANNER_RUN_TOKEN}`.
- Future scheduler wiring:
  - Use GitHub Actions cron or external cron service to call `/api/planner/run` per org.

## Monitor Tick (MVP)

- UI:
  - `/app/monitor` to run monitor tick manually and inspect recent monitor runs.
- Trigger endpoint:
  - `POST /api/monitor/run?org_id=<org_uuid>`
  - `POST /api/monitor/run` (all orgs, optional `max_orgs` query; for cron/batch)
  - optional `force_planner=1` query to run planner even with no detected signals
  - Auth:
    - `NODE_ENV=development` allows local testing.
    - otherwise requires header `x-monitor-token: ${MONITOR_RUN_TOKEN}`.
- Behavior:
  - monitor detects stale tasks/approvals/cases and recent failures/warn-block policy events.
  - planner runs only when signals exist (or force mode), and result is written to `monitor_runs`.
  - when signals are detected, monitor posts a system nudge message to shared chat (can be disabled by env).

## External Event Intake (MVP)

- UI:
  - `/app/events` で外部イベントの受信一覧確認と `pending/processed/ignored` 更新が可能。
  - 未処理イベントへ `priority` 自動仕分け（urgent/high/normal/low）を実行可能。
  - 各イベントを `Case化` して `/app/cases` の台帳へ直接起票可能（起票済みはケース詳細へリンク）。
- API:
  - `POST /api/events/intake`
  - `GET /api/events/export` (CSV, current org + filters)
  - `POST /api/events/auto-caseify?org_id=<org_uuid>` (high priority `new` events -> cases)
  - Auth:
    - `NODE_ENV=development` ではローカル検証を許可。
    - それ以外は `x-events-token: ${EVENTS_INGEST_TOKEN}` が必須。
- Request body (minimum):
  - `org_id`: UUID
  - `provider`: string (`slack` / `google` など)
  - `event_type`: string
  - `payload_json`: object
  - `external_event_id`: string (provider側イベントID, 重複排除に使用)
- Notes:
  - `(org_id, provider, external_event_id)` の重複は idempotent に受理され、既存レコードを返す。
  - provider が `google` で送られた場合は `gmail` に正規化される。
  - `POST /api/events/auto-caseify` は ops retry/circuit breaker 対応（`skipped_circuit` / `skipped_dry_run` を返却）。
  - monitor/planner は直近の未処理 inbound イベント件数をシグナルとして参照する。
  - `priority=high/urgent` の未処理イベントは `/app/events` の操作または `/api/events/auto-caseify` で自動Case化できる。

## Governance (Phase 3 baseline)

- UI:
  - `/app/governance/autonomy` for autonomy level and auto-execution thresholds.
  - `/app/governance/budgets` for budget limits/usage visibility and `google/send_email` daily limit updates.
- API:
  - `POST /api/governance/evaluate` to evaluate `google/send_email` actions with risk+trust+budget.
- Decision model:
  - Output is `allow_auto_execute | require_approval | block`.
  - `block` policy always wins.
  - Auto-execution is opt-in (default off), and requires `L3/L4` + threshold pass.
- Recommendations review:
  - `/app/governance/recommendations` has `今すぐ再評価` button.
  - `POST /api/governance/recommendations/run?org_id=<org_uuid>`
  - `POST /api/governance/recommendations/run` (all orgs, optional `max_orgs`)
  - Auth:
    - `NODE_ENV=development` allows local testing
    - otherwise requires `x-governance-token: ${GOV_RECOMMENDATIONS_TOKEN}` (fallback `PLANNER_RUN_TOKEN`)
  - Optional ops alert:
    - when `ENABLE_OPS_SLACK_ALERTS=1`, the endpoint also checks consecutive failure health and posts Slack alert on threshold breach
    - uses channel priority: connector `alert_channel_id` -> `SLACK_ALERTS_CHANNEL_ID` -> `SLACK_APPROVAL_CHANNEL_ID`
    - response includes `alert_sent`, `alert_reason`, and `alert_key` for cron log correlation
- Operations monitoring:
  - `/app/operations/jobs` shows planner/review job history with success/failure trends.
  - `/app/operations/exceptions` provides exception triage queue (failed actions/workflows, stale approvals, policy-blocked tasks).
  - exception cases support assignee/status plus SLA `due_at`; overdue/unassigned unresolved cases can be alerted to Slack.
  - includes summary cards for unresolved/overdue/max-overdue and owner backlog breakdown.
  - supports queue sorting (`priority_desc`, `due_asc`, `updated_desc`) and URL presets (`view=all|overdue_unassigned|my_open`).
  - supports bulk update for selected exception cases (`status`, `owner`, `due_at`).
  - supports CSV export for current queue filters (`owner`, `case_status`, `overdue_only`, `sort`, `view`).
  - CSV includes exception event summary columns (`exception_event_count`, latest event type/time/payload).
  - CSV begins with metadata comment lines (`# exported_at`, `# filter_*`, `# row_count`) for audit reproducibility.
  - supports `format=json` for machine-readable export (same filters/sort and metadata).
  - supports pagination via `limit` and `offset` for both CSV/JSON export.
  - supports `include_payload=0|1` to control heavy latest payload column in exports.
  - when `EXCEPTION_EXPORT_TOKEN` is configured, API accepts `x-export-token` + `org_id` for server-to-server export.
  - exception queue filter bar includes `export limit/offset` inputs and passes them to both export buttons.
  - filter bar also controls `include_payload` toggle for CSV/JSON export.
  - exception queue UI provides both CSV and JSON export buttons with current filters.
  - records case change audit trail and shows recent `exception_case_events`.
  - `/app/chat/audit` supports CSV/JSON export with current filters.
  - `/api/chat/audit/export` supports token mode (`x-export-token`) with `CHAT_EXPORT_TOKEN` + `org_id`.

### Exception Export CLI

- Script: `scripts/export-exceptions-json.mjs`
- Uses `next_offset` to fetch all pages from `/api/operations/exceptions/export?format=json`.
- Required:
  - `APP_BASE_URL`
  - `EXCEPTION_EXPORT_TOKEN`
  - `--org-id=<org_uuid>`
- Example:
  - `npm run export:exceptions -- --org-id=00000000-0000-0000-0000-000000000000 --limit=1000 --include-payload=0 --out=./exception-export.json`
  - `npm run export:exceptions -- --org-id=00000000-0000-0000-0000-000000000000 --resume-from=./exception-export.json`
  - `npm run export:exceptions -- --org-id=00000000-0000-0000-0000-000000000000 --shard-size=5000 --out=./exception-export-manifest.json`
- Notes:
  - `--resume-from` loads existing JSON export (`rows` + `meta.next_offset`) and continues fetching remaining pages.
  - `--shard-size` writes chunk files (`*.part-0001.json` ...) and stores shard manifest in `--out`.

### Chat Audit Export CLI

- Script: `scripts/export-chat-audit-json.mjs`
- Uses `next_offset` to fetch all pages from `/api/chat/audit/export?format=json`.
- Required:
  - `APP_BASE_URL`
  - `CHAT_EXPORT_TOKEN`
  - `--org-id=<org_uuid>`
- Example:
  - `npm run export:chat-audit -- --org-id=00000000-0000-0000-0000-000000000000 --status=failed --scope=all --intent=all --out=./chat-audit-export.json`
  - `npm run export:chat-audit -- --org-id=00000000-0000-0000-0000-000000000000 --resume-from=./chat-audit-export.json`
  - `npm run export:chat-audit -- --org-id=00000000-0000-0000-0000-000000000000 --shard-size=5000 --out=./chat-audit-export-manifest.json`
- Notes:
  - `--include-result=0` で `result_json` の取得を省略して軽量化できます。
  - `--resume-from` / `--shard-size` の挙動は exception export CLI と同様です。

## Scheduled Autonomy Jobs (GitHub Actions)

- Workflow: `.github/workflows/autonomy-cron.yml`
- Runs every 30 minutes and can also be started manually (`workflow_dispatch`).
- Calls:
  - `/api/monitor/run?max_orgs=<N>`
  - `/api/planner/run?max_orgs=<N>`
  - `/api/events/auto-caseify?max_orgs=<N>`
  - `/api/governance/recommendations/run?max_orgs=<N>`
  - `/api/workflows/tick?max_orgs=<N>&limit=<M>`
  - `/api/incidents/auto-open?max_orgs=<N>`
  - `/api/operations/exceptions/alerts?max_orgs=<N>`
  - `/api/approvals/reminders/auto?max_orgs=<N>&min_stale=<K>`
  - `/api/chat/confirmations/expire?max_orgs=<N>`
- Required repository secrets:
  - `APP_BASE_URL` (public reachable URL, e.g. prod URL)
  - `PLANNER_RUN_TOKEN`
- Optional repository secrets:
  - `MONITOR_RUN_TOKEN` (if omitted, planner token is reused)
  - `EVENTS_AUTOMATION_TOKEN` (if omitted, planner token is reused)
  - `GOV_RECOMMENDATIONS_TOKEN` (if omitted, planner token is reused)
  - `WORKFLOW_TICK_TOKEN` (if omitted, planner token is reused)
  - `INCIDENT_AUTOMATION_TOKEN` (if omitted, governance/planner token is reused)
  - `EXCEPTION_ALERTS_TOKEN` (if omitted, incident/governance/planner token is reused)
  - `APPROVAL_REMINDER_TOKEN` (if omitted, exception/incident/governance/planner token is reused)
  - `CHAT_CONFIRMATIONS_TOKEN` (if omitted, approval/exception/incident/governance/planner token is reused)
- Optional repository variables:
  - `AUTONOMY_API_RETRY_COUNT` (default `2`)
  - `AUTONOMY_API_RETRY_WAIT_SECONDS` (default `5`)
  - `APPROVAL_REMINDER_AUTO_MIN_STALE` (default `3`, guarded reminders threshold)

## Slack Approval Setup

1. Create a Slack app and add OAuth scopes:
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `groups:history`
   - `im:history`
   - `commands` (optional if slash commands are added later)
2. Enable Event Subscriptions and set Request URL to:
   - `${APP_BASE_URL}/api/slack/events`
3. Subscribe to bot events:
   - `app_mention`
   - `message.channels` (optional)
   - `message.groups` (optional)
   - `message.im` (optional)
4. Enable Interactivity and set Request URL to:
   - `${APP_BASE_URL}/api/slack/actions`
5. Install the app and set env vars:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_APPROVAL_CHANNEL_ID`
6. Open `/app/integrations/slack` and save connector config:
   - `approval_channel_id` (required)
   - `intake_channel_id` (optional; if empty uses approval channel)
   - `alert_channel_id` (optional)
7. If you use ops alerts, run `Opsアラート テスト送信` for connectivity check.

## Connector Configuration (Org-Scoped)

- Primary runtime config source is `connector_accounts` per org:
  - Slack config in `/app/integrations/slack` (`approval_channel_id` + optional `alert_channel_id`)
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
- `GOOGLE_REDIRECT_URI` / `GOOGLE_REDIRECT_URL` are deprecated compatibility fallbacks only when `APP_BASE_URL` is missing.
- OAuth `state` is stored server-side in Supabase (`google_oauth_states`) for replay-safe, cross-domain reliability (works with ngrok/local domain changes).

## Documentation

- [Working rules](docs/AGENT.md)
- [Decision log](docs/decisions.md)
- [Architecture](docs/architecture.md)
