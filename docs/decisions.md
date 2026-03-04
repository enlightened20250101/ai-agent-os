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
