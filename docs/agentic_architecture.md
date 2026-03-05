# Agentic Architecture Roadmap (Toward L4)

This architecture extends the current MVP foundation:
- event ledger (`lib/events/taskEvents.ts`, `task_events`)
- planner (`lib/planner/runPlanner.ts`, `/app/planner`, `/app/proposals`)
- approvals (`lib/approvals/decide.ts`, `/app/approvals`, `/api/slack/actions`)
- action runner (`/app/tasks/[id]/actions.ts`, `actions`)
- evidence pack (`/app/tasks/[id]/evidence`)

## 1) Signals and Triggers

### Current base
- Manual triggers via web UI.
- Cron/manual planner trigger via `/api/planner/run`.

### Target design
- Unified signal ingestion layer:
  - connector webhooks (Slack, future: CRM, ticketing, ERP)
  - scheduled scans
  - internal events (policy block, failed action, stale approval)
  - chat commands (shared workspace chat / personal chat)
  - backoffice events:
    - invoice/document arrival
    - payment/incoming funds status changes
    - close-cycle deadlines
    - master data changes (vendor/employee/department)

### New components
- `signal_sources` (catalog of enabled sources per org).
- `signal_events` (raw normalized signal log).
- `signal_routes` (routing rules: signal -> workflow template).

## 1.5) Conversational Command Layer (Added)

### Purpose
- Make chat the primary command surface for operators.
- Convert natural language into safe executable plans.

### Components
- Chat Gateway:
  - receives messages from web chat UI (shared/personal).
  - enforces org/member context and channel visibility.
- Intent Parser:
  - maps text to structured intents (`create_task`, `status_query`, `request_approval`, `execute_action`, etc.).
- Plan Synthesizer:
  - produces executable step plan and required confirmations.
- Confirmation Manager:
  - asks "execute this plan?" and records Yes/No with TTL.
- Command Executor:
  - dispatches confirmed plans to existing task/proposal/workflow/action services.

### Suggested schema additions
- `chat_sessions(id, org_id, scope, owner_user_id, title, created_at, updated_at)`
  - `scope in ('shared','personal')`
- `chat_messages(id, org_id, session_id, sender_type, sender_user_id, body_text, metadata_json, created_at)`
- `chat_intents(id, org_id, message_id, intent_type, confidence, intent_json, created_at)`
- `chat_confirmations(id, org_id, session_id, intent_id, status, expires_at, decided_by, decided_at, created_at)`
  - `status in ('pending','confirmed','declined','expired')`
- `chat_commands(id, org_id, session_id, intent_id, execution_status, execution_ref_type, execution_ref_id, created_at, finished_at)`

## 2) Planner

### Current base
- `runPlanner` inspects operational signals and creates `task_proposals`.

### Target design
- Multi-strategy planner:
  - deterministic rule planner
  - model planner
  - template planner
- Produces ranked proposals with rationale, risk estimate, expected impact.
- Backoffice-specific planner intents:
  - AP: invoice intake -> validation -> approval -> payment scheduling
  - AR: remittance matching -> reconciliation -> exception query
  - Close: stale/unmatched/missing-evidence backlog reduction

### New fields/tables
- `task_proposals.priority_score numeric`
- `task_proposals.estimated_impact_json jsonb`
- `planner_runs.input_snapshot_json jsonb`

## 3) Orchestrator (Workflow Engine)

### Purpose
- Execute workflows as explicit state machines, not ad-hoc server action chains.

### Model
- `workflow_templates` define step graph and required capabilities.
- `workflow_runs` instantiate template execution.
- `workflow_steps` track each step lifecycle and retries.
- Add case-centric stage model for business visibility:
  - intake -> understand -> reconcile -> approve -> execute -> close
  - mapped to technical workflow step transitions.

### Suggested schema
- `workflow_templates(id, org_id, name, version, definition_json, created_at)`
- `workflow_runs(id, org_id, task_id, proposal_id, template_id, status, started_at, finished_at, current_step_key, created_at)`
- `workflow_steps(id, org_id, workflow_run_id, step_key, step_type, status, input_json, output_json, error_json, started_at, finished_at, retry_count, created_at)`

### Indexes
- `workflow_runs(org_id, created_at desc)`
- `workflow_runs(task_id)`
- `workflow_steps(workflow_run_id, created_at)`
- `workflow_steps(org_id, status)`

## 4) Executors (Action Runners)

### Current base
- Gmail executor with idempotency and running guard.

### Target design
- Provider-agnostic executor registry:
  - `execute(action)` interface per connector/action type
  - per-connector scopes + rate limits
  - compensation handlers for reversible actions
- Action classes by risk:
  - read/query actions
  - document/workflow updates
  - monetary or customer-facing side effects (strictest gating)

### Suggested schema additions
- `actions.workflow_run_id uuid null`
- `actions.step_id uuid null`
- `actions.attempt int default 1`
- `actions.error_code text null`
- `actions.latency_ms int null`

## 5) Guardrails (Policy + Risk + Budgets)

### Current base
- Deterministic policy checks and domain constraints in `lib/policy/check.ts`.

### Target design
- Layered guardrails:
  - static policy rules
  - risk scoring
  - trust scoring
  - budget controls (daily spend, action quotas, domain limits)
  - SoD checks (requester != approver, initiator != payer)

### Suggested schema
- `policy_rules(id, org_id, scope_type, scope_id, rule_key, config_json, status, created_at)`
- `risk_assessments(id, org_id, task_id, proposal_id, action_fingerprint, risk_score, dimensions_json, created_at)`
- `trust_scores(id, org_id, subject_type, subject_id, score, factors_json, updated_at)`
- `budget_limits(id, org_id, budget_key, limit_value, period, policy_json, created_at)`
- `budget_usage(id, org_id, budget_key, period_start, consumed_value, updated_at)`

## 6) Memory and Learning Loop

### Purpose
- Convert outcomes and human corrections into better decisions.

### Data loop
- Collect signals from:
  - approvals/rejections and reasons
  - execution success/failure and retries
  - manual edits after drafts
- Track exception recovery quality:
  - question effectiveness
  - time-to-resolution
  - repeat exception patterns by vendor/workflow
- Train/update heuristic weights (not necessarily ML first).

### Suggested schema
- `feedback_events(id, org_id, task_id, proposal_id, source, feedback_type, payload_json, created_at)`
- `outcome_summaries(id, org_id, period_start, period_end, metrics_json, created_at)`
- `agent_preferences(id, org_id, agent_id, preference_json, updated_at)`

## 7) Incident Handling and Safe Mode

### Current base
- Action failure logging and skip events.

### Target design
- Automated incident subsystem with circuit breakers.

### Suggested schema
- `incidents(id, org_id, severity, status, trigger_type, summary, context_json, opened_at, resolved_at, owner_user_id)`
- `incident_events(id, org_id, incident_id, event_type, payload_json, created_at)`
- `org_runtime_modes(org_id pk, mode, reason, changed_by, changed_at)` where `mode in ('normal','degraded','safe_mode')`

### Runtime behavior
- Trigger safe mode on threshold breaches (policy violations, high failure burst, trust collapse).
- In safe mode: disable autopilot, force human approvals, increase alerting.

## 8) Unified Business Ledger (Case-Centric)

### Purpose
- Merge source artifacts, extracted facts, workflow state, and execution audit into a single case timeline.

### Suggested schema extensions
- `business_cases(id, org_id, case_type, source_type, source_ref, status, priority, opened_at, closed_at, created_at)`
- `case_artifacts(id, org_id, case_id, artifact_type, storage_ref, hash, metadata_json, created_at)`
- `case_links(id, org_id, case_id, entity_type, entity_id, relation_type, created_at)`

### Notes
- Existing `tasks` can remain operational unit in MVP; `business_cases` becomes cross-task umbrella as autonomy grows.

## 9) Document Intelligence Layer (Phased)

### Purpose
- Convert invoices/receipts/contracts/emails into structured facts with confidence and anchor spans.

### Suggested schema extensions
- `document_extractions(id, org_id, case_id, artifact_id, schema_key, extracted_json, confidence_json, created_at)`
- `evidence_anchors(id, org_id, case_id, artifact_id, anchor_type, anchor_ref, extracted_field, created_at)`

### Guardrails
- Never auto-execute high-impact actions when extraction confidence and policy confidence are both below threshold.

## Event Model Extensions

Extend `task_events` with these types:
- `CHAT_MESSAGE_RECEIVED`
- `CHAT_INTENT_PARSED`
- `CHAT_PLAN_PROPOSED`
- `CHAT_CONFIRMATION_REQUESTED`
- `CHAT_CONFIRMED`
- `CHAT_DECLINED`
- `SIGNAL_RECEIVED`
- `WORKFLOW_STARTED`
- `WORKFLOW_STEP_STARTED`
- `WORKFLOW_STEP_COMPLETED`
- `WORKFLOW_STEP_FAILED`
- `WORKFLOW_REPLANNED`
- `RISK_SCORED`
- `TRUST_EVALUATED`
- `APPROVAL_BYPASSED`
- `BUDGET_CHECKED`
- `BUDGET_EXCEEDED`
- `INCIDENT_OPENED`
- `INCIDENT_ESCALATED`
- `SAFE_MODE_ENABLED`
- `SAFE_MODE_DISABLED`

Add proposal/planner ecosystem types:
- `PROPOSAL_RISK_UPDATED`
- `PROPOSAL_POLICY_BLOCKED`

## Responsibility Tracing Model
For every side effect, persist:
- actor identity (`user`, `agent`, `system`)
- decision source (`policy_rule`, `risk_gate`, `human_override`)
- idempotency key / action fingerprint
- approval artifact reference (if applicable)
- connector account id used

This keeps accountability explicit at org, workflow, and action levels.

## Security Defaults
- No tokens or secrets in event payloads/logs.
- Connector credentials retrieved server-side only.
- Org-scoped queries in every read/write path.
- Sensitive fields redacted in UI except explicit secret entry forms.
- Service-role usage restricted to bootstrap/internal system jobs.
