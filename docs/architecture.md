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
8. Planner loop proposes follow-up tasks and suggested actions for human acceptance.

## Module Boundaries

### 1) Event Ledger

- Responsibility: Immutable audit events for every state change and external action.
- Backing store: Supabase Postgres table(s) with RLS.
- Event examples: `SLACK_TASK_INTAKE`, `TASK_CREATED`, `MODEL_INFERRED`, `POLICY_CHECKED`, `APPROVAL_REQUESTED`, `APPROVAL_BYPASSED`, `HUMAN_APPROVED`, `ACTION_SKIPPED`, `ACTION_EXECUTED`, `ACTION_FAILED`, `INCIDENT_DECLARED`, `GOVERNANCE_RECOMMENDATION_APPLIED`, `GOVERNANCE_RECOMMENDATIONS_REVIEWED`, `GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED`.
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
- Config source: per-org `connector_accounts` first, env fallback second for local/dev.

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
- Exception extension: include `exception_cases` and `exception_case_events` linked to the task when available.
- Data source: Event Ledger only.

### 6) Autonomous Task Proposer

- Responsibility: Periodically inspect workflow signals and propose high-leverage tasks/actions.
- Inputs: stale tasks, recent action failures, stale approvals, policy warnings/blocks.
- Outputs: `task_proposals` rows with rationale, risks, action drafts, and policy evaluation.
- Safety: proposals require human accept/reject; execution still goes through existing approval + action runner gates.

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
- MVP note: `secrets_json` is stored as plain JSON in MVP; encryption hardening is future work.
- `slack_event_receipts`: Slack Events API受信の重複排除テーブル (`event_id` unique)。
- `actions`: outbound provider action attempts and results.
- `workflow_templates`: reusable multi-step workflow definitions.
- `workflow_runs`: workflow execution instances per task.
- `workflow_steps`: step-level execution state for each run.
  - MVP step types: `task_event`, `execute_google_send_email`.
- `planner_runs`: autonomous planner run lifecycle and summaries.
- `task_proposals`: planner-generated candidate tasks awaiting human decision.
- `proposal_events`: immutable audit events for proposal and planner decisions.
- `org_autonomy_settings`: org-level autonomy/risk/trust threshold settings.
- `risk_assessments`: immutable risk scoring snapshots for task/proposal actions.
- `trust_scores`: historical trust scores for provider/action/agent-role.
- `budget_limits`: org-level execution caps (e.g., daily send_email limit).
- `budget_usage`: daily usage counters used for auto-execution budget checks.
- `org_incidents`: org-level incident mode ledger (`open`/`resolved`) that can force governance `block`.
- `exception_cases`: triage tracker for operational exceptions with owner/status (`open`/`in_progress`/`resolved`).
- `exception_case_events`: append-only audit log for exception case lifecycle updates and notifications.
- `incident_events`: incident-specific append-only ledger (e.g. `INCIDENT_AUTO_DECLARED`) for trigger/threshold audit.

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
- `SLACK_TASK_INTAKE`
- `TASK_UPDATED`
- `APPROVAL_REQUESTED`
- `APPROVAL_BYPASSED`
- `SLACK_APPROVAL_POSTED`
- `HUMAN_APPROVED`
- `HUMAN_REJECTED`
- `MODEL_INFERRED`
- `POLICY_CHECKED`
- `ACTION_QUEUED`
- `ACTION_SKIPPED`
- `ACTION_EXECUTED`
- `ACTION_FAILED`
- `WORKFLOW_STARTED`
- `WORKFLOW_STEP_STARTED`
- `WORKFLOW_STEP_COMPLETED`
- `WORKFLOW_RETRIED`
- `WORKFLOW_COMPLETED`
- `WORKFLOW_FAILED`
- `INCIDENT_DECLARED`
- `INCIDENT_RESOLVED`
- `GOVERNANCE_RECOMMENDATION_APPLIED`
- `GOVERNANCE_RECOMMENDATION_FAILED`
- `GOVERNANCE_RECOMMENDATIONS_REVIEWED`
- `GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED`
- `OPS_ALERT_POSTED`
- `OPS_ALERT_FAILED`
- `OPS_JOB_CIRCUIT_ALERT_POSTED`
- `OPS_JOB_CIRCUIT_ALERT_FAILED`
- `OPS_JOB_RETRY_SCHEDULED`
- `OPS_JOB_RETRY_RECOVERED`
- `OPS_JOB_RETRY_EXHAUSTED`
- `OPS_JOB_SKIPPED_CIRCUIT_OPEN`
- `OPS_JOB_CIRCUIT_OPENED`
- `OPS_JOB_CIRCUIT_CLOSED`
- `OPS_JOB_CIRCUIT_MANUALLY_CLEARED`
- `OPS_JOB_DRY_RUN_PASSED`
- `OPS_JOB_DRY_RUN_FAILED`
- `INCIDENT_AUTO_DECLARED` (in `incident_events`)
- `PROPOSAL_CREATED`
- `PROPOSAL_ACCEPTED`
- `PROPOSAL_REJECTED`
- `PLANNER_RUN_STARTED`
- `PLANNER_RUN_FINISHED`

## Reliability and Observability

- Idempotency keys on external send/approval callbacks.
- Structured event payloads for deterministic evidence generation.
- Error paths must write `error_recorded` ledger events with context.
