# Implementation Plan (6 Phases, 1-2 Weeks Each)

Assumption: small team (2-4 engineers + AI coding support), incremental delivery, existing stack/patterns retained.

## Phase 1 (L2): Proposal-Centric Planning Experience

### User-visible features
- Improve planner quality and proposal triage UX.
- Proposal filters by reason/risk/policy status.
- Proposal accept/reject reason taxonomy.
- Conversational read layer (chat-based status Q&A, no side effects).
- Backoffice trigger presets:
  - overdue approvals
  - failed executions
  - deadline proximity (close cycle)
  - unmatched/blocked operational records

### DB changes
- `task_proposals`:
  - add `priority_score numeric`
  - add `estimated_impact_json jsonb`
  - add `decision_reason text`
- `proposal_events`:
  - add index `(org_id, proposal_id, created_at)`

### Endpoints/pages
- Extend `/app/proposals` with sorting/filtering/bulk actions.
- Extend `/app/planner` with run diagnostics and input snapshot preview.
- Add route handler `/api/planner/runs/:id` (run detail).
- Add `/app/chat/shared`, `/app/chat/me`, `/app/chat/channels` with `@AI` explicit execution gate.
- Add `/app/executions` org-wide execution history with rich filters.
- Add `/app/partners` for vendor/external-contact management.

### E2E extensions
- Verify proposal filtering and accept/reject reason persistence.
- Verify proposal->task conversion still logs `TASK_CREATED`, `MODEL_INFERRED`, `POLICY_CHECKED`.
- Verify chat status query returns current task/approval summary.

### Definition of done
- Proposal acceptance rate and reject reasons visible in UI.
- No regression in existing create->approve->execute flow.
- All planner/proposal actions are org-scoped and ledgered.

## Phase 2: Workflow Templates + Orchestrator (Approval-First)

### User-visible features
- Workflow templates page (define multi-step flows).
- Workflow run view with step-by-step status and retry actions.
- Tasks can attach a workflow template.
- Chat command parser + plan preview (confirmation required).
- Add case-stage templates for backoffice:
  - intake -> reconcile -> approve -> execute -> close

### DB changes
- Add `workflow_templates`, `workflow_runs`, `workflow_steps`.
- Add `tasks.workflow_template_id uuid null`.
- Add indexes for run/step status queries.
- Add `chat_sessions`, `chat_messages`, `chat_intents`, `chat_confirmations`, `chat_commands`.

### Endpoints/pages
- `/app/workflows` (template list/create/edit)
- `/app/workflows/runs` and `/app/workflows/runs/[id]`
- `/api/workflows/run` to start runs from tasks/proposals.
- `/api/chat/message` (ingest), `/api/chat/confirm` (Yes/No), `/api/chat/execute` (dispatch confirmed command).

### E2E extensions
- Create template -> start run -> complete step sequence with approval.
- Failure path test: step failure creates exception state and retry works.
- Chat: "タスクを追加して" -> plan preview -> Yes -> task created with chat lineage events.

### Definition of done
- Deterministic workflow state machine with explicit transitions.
- Each step transition emits workflow events in ledger.
- No hidden execution logic outside orchestrator path.

## Phase 3 (L3): Low-Risk Autopilot for Selected Actions

### User-visible features
- Autonomy settings page per org (`L0-L3` toggles by action type).
- “Auto-executed” badges and rationale in task timeline.
- Approval queue excludes policy-approved low-risk actions.
- Chat-triggered low-risk command auto-execution under policy/trust gates.
- Add SoD policy presets for finance ops:
  - initiator/approver separation
  - high-amount forced approval

### DB changes
- Add `risk_assessments`, `trust_scores`, `budget_limits`, `budget_usage`.
- Add `actions` fields: `workflow_run_id`, `step_id`, `attempt`, `error_code`, `latency_ms`.

### Endpoints/pages
- `/app/governance/autonomy`
- `/app/governance/budgets`
- `/api/governance/evaluate` (risk+trust decision endpoint for orchestrator use).

### E2E extensions
- Scenario: low-risk action auto-executes (no human approval) and logs `APPROVAL_BYPASSED`.
- Scenario: same action with low trust requires approval.

### Definition of done
- Autopilot only for explicitly allowed low-risk actions.
- Hard policy blocks still always block.
- Budget and idempotency protections validated under retries/concurrency.
- Chat-origin executions preserve message->intent->execution evidence chain.

## Phase 4: Multi-Step Autonomy + Exception Handling

### User-visible features
- Exception inbox page with severity and ownership.
- Safe mode toggle at org level.
- Workflow compensation/recovery actions.
- Exception recovery assistant:
  - targeted clarification prompts
  - auto-assignment and SLA escalation
  - explicit next-best-action suggestions

### DB changes
- Add `incidents`, `incident_events`, `org_runtime_modes`.
- Add `workflow_steps.compensation_json` (optional) and `requires_human boolean`.

### Endpoints/pages
- `/app/incidents`
- `/app/incidents/[id]`
- `/api/runtime/safe-mode` (enable/disable with audit event)

### E2E extensions
- Trigger repeated action failures -> incident opens -> safe mode enables.
- Verify safe mode forces approvals and blocks auto-execute paths.

### Definition of done
- Automatic incident opening and escalation for defined thresholds.
- Safe mode reliably degrades autonomy and is auditable.
- Exception handling flow has owner assignment and resolution trail.

## Phase 5: Learning Loop + Operational Analytics

### User-visible features
- Dashboard: success rate, approval latency, policy block rate, trust trend, savings estimate.
- Policy tuning suggestions based on outcomes.
- Agent quality scorecards.
- Backoffice KPI set:
  - touchless processing rate
  - reconciliation cycle time
  - exception recurrence rate
  - audit finding rate

### DB changes
- Add `feedback_events`, `outcome_summaries`, `agent_preferences`.
- Materialized views for org KPI rollups.

### Endpoints/pages
- `/app/analytics`
- `/app/governance/recommendations`
- `/api/metrics/refresh` (scheduled aggregation)

### E2E extensions
- Verify rejected approvals and manual corrections feed analytics counters.
- Verify recommendation generation is org-scoped and deterministic with fixture data.

### Definition of done
- Dashboards reflect real ledger/action/approval data.
- Feedback pipeline updates trust/risk factors on schedule.
- Recommendation outputs are explainable and non-destructive.

## Phase 6: Enterprise Hardening + Compliance Readiness

### User-visible features
- Connector scope management (least privilege per org/connector).
- Key rotation controls and audit exports.
- Compliance report center (SOC2-ready evidence views).
- Formal control packs for backoffice audits:
  - approval lineage
  - evidence-anchor completeness
  - SoD violation reports

### DB changes
- Encrypt `connector_accounts.secrets_json` at rest (KMS-backed envelope or pgcrypto strategy).
- Add `audit_exports`, `access_audit_logs`, `key_rotation_events`.
- Add immutable ledger checksum chain metadata (optional table or event payload extension).

### Endpoints/pages
- `/app/security/connectors`
- `/app/security/audit-exports`
- `/api/security/rotate-keys`

### E2E extensions
- Verify secret update/redaction paths never expose plaintext.
- Verify audit export generation and integrity metadata.

### Definition of done
- Secrets encrypted at rest and never logged.
- Access and admin actions fully auditable.
- External audit walkthrough can be completed from product evidence.

## Delivery Cadence and Engineering Process
- Keep each phase behind feature flags per org.
- Expand Playwright flows phase-by-phase; preserve deterministic `E2E_MODE=1` stubs.
- Require: migration + RLS + event schema + UI + tests in same slice.
- Keep rollback path for every autonomy increment.
