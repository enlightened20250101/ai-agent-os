# decisions.md

## Decision Log

This file records implementation decisions made without blocking on open questions.

### 2026-03-05 - Base stack

- Decision: Use Next.js (App Router) + TypeScript + Supabase Postgres/Auth.
- Why: Fastest solo-developer path with strong defaults for auth, server routes, and deployment.

### 2026-03-05 - MVP scope boundary

- Decision: MVP includes only the wedge flow:
  Slack task intake -> LLM draft -> policy check -> Slack approval -> Gmail send -> event ledger -> HTML evidence pack.
- Why: Keeps scope tight around the product wedge and audit value.

### 2026-03-05 - Connector scope

- Decision: Implement only Slack and Gmail connectors in MVP.
- Why: Required by scope and enough to validate intake/approval/output loop.

### 2026-03-05 - Event model priority

- Decision: Treat Event Ledger as first-class source of truth for workflow state.
- Why: Logging/auditability is core product value and supports evidence generation.

### 2026-03-05 - Evidence Pack format

- Decision: Output Evidence Pack as an HTML page in MVP; PDF is `future`.
- Why: HTML is fastest to ship and easy to iterate; PDF can be generated later from the same event data.

### 2026-03-05 - Policy engine behavior

- Decision: Start with deterministic rule checks before any model-based moderation.
- Why: Predictable behavior, faster debugging, and easier compliance traceability.

## future

- Add PDF rendering pipeline from the same Evidence Pack data.
- Add richer policy rule authoring UI and test harness.

### 2026-03-05 - App route protection strategy

- Decision: Protect all `/app` routes with middleware session validation plus a server-side fallback guard in `/app/layout.tsx`.
- Why: Middleware handles primary access control and auth-route redirects; layout guard prevents accidental bypass.

### 2026-03-05 - Auth flow defaults

- Decision: Use Supabase email/password auth with client-side login/signup forms and client-side logout action.
- Why: Fastest stable setup for initial scaffold while keeping real Supabase integration.

### 2026-03-05 - UI scaffolding defaults

- Decision: Include minimal section pages for `/app/agents`, `/app/tasks`, and `/app/approvals` as initial navigable placeholders.
- Why: Satisfies end-to-end navigation now and enables incremental feature delivery in future slices.

### 2026-03-05 - Signup confirmation handling

- Decision: Support both Supabase modes where email confirmation is required or not required.
- Why: Existing Supabase project settings are assumed to be pre-configured; signup flow now handles no-session responses with a clear confirmation message.

### 2026-03-05 - Schema implementation choice

- Decision: Implement constrained statuses/providers/actor types as Postgres ENUMs in the initial migration.
- Why: Faster to enforce correctness at the database boundary and keeps event/action states consistent.

### 2026-03-05 - RLS baseline strategy

- Decision: Apply strict org-scoped RLS across all tables via helper function `is_org_member(org_id uuid)`.
- Why: Keeps policy logic centralized, easy to audit, and aligned to the product's tenant isolation needs.

### 2026-03-05 - Org provisioning path

- Decision: Block direct authenticated inserts to `orgs`; create initial org + owner membership only through server-side onboarding with service role key.
- Why: Guarantees first-write bootstrap while preserving strict user-facing RLS.

### 2026-03-05 - New-user routing

- Decision: Middleware enforces onboarding redirect for authenticated users without memberships until provisioning is completed.
- Why: Ensures all `/app` features run with valid org context.

### 2026-03-05 - CRUD data access mode

- Decision: Use user-scoped Supabase server client for all Agents/Tasks/Approvals CRUD and event writes.
- Why: RLS should be exercised directly by application flows; service-role access remains reserved for onboarding bootstrap only.

### 2026-03-05 - MVP org context selection

- Decision: For MVP, the active org is the first membership by `created_at` for the current user.
- Why: Eliminates org-switching complexity while preserving strict org scoping in every query/write.

### 2026-03-05 - Agent event logging on task_events

- Decision: Store `AGENT_CREATED` / `AGENT_UPDATED` in `task_events` by attaching them to a per-org internal task `__SYSTEM_AGENT_EVENTS__`.
- Why: Current schema requires non-null `task_id` on task events, and this preserves unified event storage without changing schema constraints.

### 2026-03-05 - E2E framework choice

- Decision: Use Playwright with a real local Next.js dev server for end-to-end checks.
- Why: Fastest reliable browser automation path for full flow validation in App Router apps.

### 2026-03-05 - E2E cleanup safety model

- Decision: Add `/api/test/cleanup` route that only works in test mode (`NODE_ENV=test` or `E2E_MODE=1`) and requires `E2E_CLEANUP_TOKEN`.
- Why: Keeps cleanup available for tests while preventing production misuse.

### 2026-03-05 - CI test execution mode

- Decision: CI runs `lint`, `typecheck`, and Playwright E2E using repository secrets for Supabase and E2E credentials.
- Why: Ensures the main user-facing workflow is continuously validated with real auth/database integration.

### 2026-03-05 - E2E user provisioning path

- Decision: Provision E2E users through test-only endpoint `/api/e2e/provision-user` via Supabase admin API, then login through `/login` in Playwright.
- Why: Avoids flaky browser signup creation path while still validating authenticated product flows end-to-end.

### 2026-03-05 - E2E failure forensics behavior

- Decision: Skip org cleanup when E2E test fails and emit debug log with `orgId` and `taskId`.
- Why: Preserves failing test artifacts/data in Supabase for SQL-level debugging and replay.

### 2026-03-05 - Dynamic rendering for workflow pages

- Decision: Mark Tasks/Task Detail/Approvals pages as `force-dynamic`.
- Why: Avoid stale cached reads after server actions so status and event timelines reflect latest DB writes (including `HUMAN_APPROVED`/`HUMAN_REJECTED`).

### 2026-03-05 - Draft generation and policy MVP

- Decision: Generate structured draft JSON server-side via OpenAI with deterministic prompt/temperature and store results in `MODEL_INFERRED`.
- Why: Keeps draft generation auditable and reusable by approvals/actions pipeline.

### 2026-03-05 - E2E LLM stub mode

- Decision: When `E2E_MODE=1`, LLM helper returns deterministic server-side stub output and skips real OpenAI calls.
- Why: Makes E2E stable, fast, and independent of external model/network variability.

### 2026-03-05 - Approval gating by draft policy

- Decision: `Request Approval` is enabled only when latest draft exists and latest policy status is not `block`.
- Why: Enforces minimal safety policy before human approval flow.

### 2026-03-05 - Slack approvals are optional

- Decision: Keep web approvals as canonical and add Slack approvals as an optional additional channel.
- Why: Ensures approvals still work when Slack is not configured or temporarily unavailable.

### 2026-03-05 - Single-tenant Slack mapping for MVP

- Decision: Use environment-based Slack config (`SLACK_*`) for one workspace/channel in MVP, while keeping code paths compatible with future per-org connector configuration.
- Why: Minimal implementation speed with a straightforward migration path to `connector_accounts` later.

### 2026-03-05 - Slack interactive approval security

- Decision: Verify Slack request signatures and require HMAC-signed short-lived action tokens for approval actions.
- Why: Prevents forged approval/rejection requests and avoids trusting client-supplied org/task identifiers.

### 2026-03-05 - Gmail as first action runner connector

- Decision: Execute only the first `google/send_email` proposed action for MVP and log full action lifecycle in `actions` + `task_events`.
- Why: Minimal deterministic runner path that is auditable and easy to extend to multi-action plans later.

### 2026-03-05 - Gmail execution safety gates

- Decision: Enforce execution only when task is `approved`, latest policy is not `block`, and recipient domain passes allowlist when configured.
- Why: Keeps outbound connector execution aligned with approval/policy intent.

### 2026-03-05 - Gmail E2E stub

- Decision: In `E2E_MODE=1`, Gmail send returns deterministic message id without external API calls while still writing `actions` and `ACTION_*` events.
- Why: Preserves end-to-end execution coverage without sending real emails.
