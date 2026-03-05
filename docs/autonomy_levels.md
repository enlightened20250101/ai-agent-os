# Autonomy Levels (L0-L4)

This model defines how AI Agent OS gradually moves from operator-assisted execution to exception-only supervision.

## Shared controls across all levels
- Org-scoped authorization (Supabase RLS + `org_id`).
- Event evidence in `task_events` and `actions`.
- Idempotency keys for side-effect actions.
- Policy check before approval/execution.
- Connector credentials sourced per org via `connector_accounts`.
- Chat command traceability (`chat_session_id`, `message_id`, parsed_intent, confirmation_result).

## L0: Manual Operations

### Allowed actions
- Human creates tasks manually (`/app/tasks`).
- Human decides approvals (`/app/approvals` web or Slack).
- Human triggers execution explicitly.
- Chat is read-only assistive (FAQ/status lookup) with no side-effect execution.

### Required approvals
- Human approval required for all external actions.

### Required evidence
- `TASK_CREATED`, `TASK_UPDATED`, `APPROVAL_REQUESTED`, `HUMAN_APPROVED`/`HUMAN_REJECTED`, `ACTION_*`.
- Evidence pack per task (`/app/tasks/[id]/evidence`).
- For chat queries: `CHAT_MESSAGE_RECEIVED`, `CHAT_RESPONSE_SENT`.

### Monitoring and alerts
- Basic failure alert on `ACTION_FAILED`.
- Daily report: tasks stuck in `ready_for_approval`.

## L1: AI Drafting Assistant

### Allowed actions
- AI generates structured drafts (`MODEL_INFERRED`) and policy checks (`POLICY_CHECKED`).
- Human still initiates task and execution.
- AI can parse chat commands into proposed plans, but cannot execute without explicit human click/confirmation.

### Required approvals
- Human approval required for all executions.
- Human review required for generated draft before approval request.

### Required evidence
- Include model metadata, normalized output, coercions, and policy rationale in event payloads.
- `CHAT_INTENT_PARSED`, `CHAT_PLAN_PROPOSED`.

### Monitoring and alerts
- Draft generation failure rate.
- Policy warn/block rate by agent/connector.

## L2: AI Proposes Work (Current trajectory)

### Allowed actions
- Planner creates proposals (`planner_runs`, `task_proposals`).
- Humans accept/reject proposals.
- Accepted proposal converts into regular task with seeded model/policy events.
- Chat can create proposals/tasks and trigger approval requests after explicit "Yes" confirmation.

### Required approvals
- Human decision required at proposal acceptance and execution stages.

### Required evidence
- `PLANNER_RUN_*`, `PROPOSAL_CREATED`, `PROPOSAL_ACCEPTED`/`PROPOSAL_REJECTED`.
- Link from task to proposal origin (in `TASK_CREATED` payload).
- `CHAT_CONFIRMATION_REQUESTED`, `CHAT_CONFIRMED`, `CHAT_DECLINED`.

### Monitoring and alerts
- Proposal acceptance ratio.
- False-positive proposal rate (human rejection reason categories).
- Planner run failures and stale proposal backlog.

## L3: Constrained Autopilot for Low-Risk Actions

### Allowed actions
- Auto-execute actions classified as low-risk and within policy/budget envelopes.
- Human approval still required for medium/high risk.
- Chat-triggered low-risk actions can auto-execute if policy/trust thresholds are met.

### Required approvals
- Conditional:
  - Low risk + trusted agent/connector: no pre-approval, post-audit required.
  - Medium risk: explicit approval.
  - High risk: dual approval or block (org policy).

### Required evidence
- Risk/trust snapshot at decision time.
- Approval bypass reason (policy reference + threshold values).
- Budget consumption and rate-limit counters.
- Chat-origin metadata for every execution (`chat_actor`, `chat_session_id`, command text hash).

### Monitoring and alerts
- Real-time anomaly alerts (execution spikes, trust drops, policy bypass volume).
- SLA on incident triage for `ACTION_FAILED` and `ACTION_SKIPPED` bursts.
- Auto rollback to L2 when breach thresholds are hit.

## L4: Full Workflow Autonomy with Exceptions

### Allowed actions
- Multi-step workflows execute end-to-end automatically.
- Dynamic replanning and fallback path selection.
- Human involvement only for exceptions/overrides.
- Shared chat becomes the default operational command plane; personal chat remains private assistive plane.

### Required approvals
- Policy-governed exception-only approvals:
  - critical-risk actions
  - incident mode operations
  - privileged connector scope changes

### Required evidence
- Workflow-level lineage (run graph, step decisions, retries, compensation actions).
- Immutable incident timeline and override history.
- Signed evidence bundle for compliance export.
- Full chat-to-action lineage (message -> intent -> plan -> confirmation -> execution).

### Monitoring and alerts
- Org-level autonomy health score.
- Drift detection (policy violations, trust erosion, unusual spend).
- Continuous control checks with auto safe-mode trigger.

## Level Transition Gates
To move up a level, an org must satisfy:
- Minimum success rate threshold over rolling window.
- Maximum policy violation threshold.
- Incident response maturity (runbooks + on-call ownership).
- Evidence completeness SLO (no missing critical events).
