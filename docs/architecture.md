# architecture.md

## Overview

The AI Agent OS MVP is an auditable workflow system that transforms Slack task requests into approved outbound Gmail messages with full event history and a generated HTML Evidence Pack.

Primary workflow:

1. Slack intake receives a task.
2. Draft service generates an LLM draft.
3. Policy engine evaluates draft and metadata.
4. Approval service posts for Slack approval.
5. On approval, Gmail connector sends the message.
6. Event Ledger records every transition.
7. Evidence Pack service renders an HTML report from ledger events.

## Module Boundaries

### 1) Event Ledger

- Responsibility: Immutable audit events for every state change and external action.
- Backing store: Supabase Postgres table(s) with RLS.
- Event examples: `TASK_CREATED`, `MODEL_INFERRED`, `POLICY_CHECKED`, `APPROVAL_REQUESTED`, `HUMAN_APPROVED`, `ACTION_SKIPPED`, `ACTION_EXECUTED`, `ACTION_FAILED`.
- Requirement: All modules write to ledger through a shared server-side writer.

### 2) Policy Engine

- Responsibility: Gate outbound actions with deterministic checks.
- Input: Draft content, recipient metadata, task context.
- Output: `pass`/`fail` + rule results + rationale for ledger.
- MVP behavior: Rule-based checks only (length bounds, blocked terms, missing required metadata).

### 3) Connector Gateway

- Responsibility: Unified adapter interface for external systems.
- MVP connectors:
  - Slack: intake and approval interactions.
  - Gmail: final outbound send.
- Constraint: Secrets used only server-side; connector actions always ledgered.

### 4) Approval Service

- Responsibility: Human-in-the-loop decision point.
- Flow:
  - Create approval request from policy-passed draft.
  - Publish to Slack for approver action.
  - Validate callback authenticity.
  - Emit approval/rejection event.

### 5) Evidence Pack Service

- Responsibility: Build human-readable trace for a single workflow run.
- Output (MVP): HTML page showing timeline, policy results, approvals, outbound metadata, and send result.
- Data source: Event Ledger only.

## Runtime Design

- Frontend: Next.js App Router pages for operator UI and evidence pages.
- Backend: Route handlers and server actions for workflow operations.
- Auth: Supabase Auth (email/password) for internal app access.
- Authorization: Supabase RLS to constrain tenant/user data access.

## Data Model (MVP-level)

- `orgs`: tenant boundary.
- `memberships`: maps authenticated users to orgs with role (`owner`/`admin`/`member`).
- `agents`: org-scoped agents with role key and lifecycle status.
- `tasks`: intake/draft execution unit linked to creator and optional agent.
- `task_events`: append-only event ledger entries per task.
- `approvals`: human approval state for tasks.
- `connector_accounts`: org connector identities and encrypted secret blobs.
- `actions`: outbound provider action attempts and results.

## Schema Notes

- Primary keys are UUIDs (`gen_random_uuid()`), all timestamps are `timestamptz` in UTC defaults.
- Multi-tenant access is enforced by `org_id` on all domain tables.
- RLS is enabled on all tables with policy gating through `is_org_member(org_id uuid)`.
- Regular authenticated users cannot create `orgs` directly under RLS.
- Initial org + owner membership is created via server-side onboarding using Supabase service role key.

## Event Types (Minimum Set)

- `ORG_CREATED`
- `MEMBERSHIP_CREATED`
- `AGENT_CREATED`
- `AGENT_UPDATED`
- `TASK_CREATED`
- `TASK_UPDATED`
- `APPROVAL_REQUESTED`
- `SLACK_APPROVAL_POSTED`
- `HUMAN_APPROVED`
- `HUMAN_REJECTED`
- `MODEL_INFERRED`
- `POLICY_CHECKED`
- `ACTION_QUEUED`
- `ACTION_SKIPPED`
- `ACTION_EXECUTED`
- `ACTION_FAILED`

## Reliability and Observability

- Idempotency keys on external send/approval callbacks.
- Structured event payloads for deterministic evidence generation.
- Error paths must write `error_recorded` ledger events with context.
