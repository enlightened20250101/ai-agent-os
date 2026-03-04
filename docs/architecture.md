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
- Event examples: `task_intake_received`, `draft_generated`, `policy_passed`, `approval_requested`, `approval_granted`, `gmail_sent`, `evidence_pack_generated`, `error_recorded`.
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

- `work_items`: high-level unit of work from Slack intake.
- `drafts`: generated draft content and model metadata.
- `approvals`: approval requests and status.
- `outbound_messages`: Gmail send attempts/results.
- `event_ledger`: append-only event records with actor, timestamp, event type, payload JSON.

## Reliability and Observability

- Idempotency keys on external send/approval callbacks.
- Structured event payloads for deterministic evidence generation.
- Error paths must write `error_recorded` ledger events with context.
