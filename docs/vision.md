# Vision: AI Agent OS End-State (10-Year Target)

## Product Promise
AI Agent OS becomes the operational control plane where organizations delegate recurring operational work to AI under explicit governance. The system continuously identifies work, proposes plans, executes approved actions, and produces audit-ready evidence for every decision and side effect.

The default operating model is:
- AI handles discovery, planning, drafting, execution, retries, and routine follow-up.
- Humans handle permissions, policy tuning, exception resolution, and periodic quality review.

## End-State User Experience

### Conversation-first operating model (added)
- The primary interface is AI chat, not form-first UI.
- Users can ask in natural language:
  - "〇〇というタスクを追加して"
  - "〜ってどうなってる？"
  - "この承認待ちを進めて"
- AI translates requests into executable plans, then asks for execution confirmation:
  - "次の操作を実行してよいですか？"
  - User confirms Yes/No.
- On Yes, AI executes through the same policy/approval/action-runner gates without requiring manual button clicks.

### Shared and personal chat lanes (added)
- Shared workspace chat:
  - org/department-wide operational conversation and commands.
  - visible to members, used for team-level tasks/status/incident handling.
- Personal chat:
  - private Q&A, drafts, and personal context lookups.
  - can still trigger org-side actions, but requires explicit confirmation and audit trail.
- Both chat lanes produce ledgered events and can be replayed in Evidence Pack context.

### Human role
- Define policy and autonomy boundaries per org, workflow, connector, and risk tier.
- Review high-risk approvals and exception queues.
- Inspect evidence packs and KPI dashboards.
- Manage incidents, run postmortems, and approve policy/autonomy changes.

### AI role
- Continuously ingest signals from connected systems.
- Convert signals into prioritized tasks/proposals.
- Generate drafts/plans with structured actions.
- Execute eligible actions automatically within risk/policy budgets.
- Escalate uncertain/high-risk/failed cases with full context.

### Typical workflow
1. Signal arrives (Slack, app event, connector webhook, scheduler).
2. Planner/orchestrator maps signal to a workflow template.
3. AI drafts outputs and proposed actions.
4. Guardrails score risk and enforce policy.
5. Execution route is selected:
   - auto-execute (low risk + high trust + allowed autonomy)
   - require approval
   - block and escalate
6. Action runner executes idempotently with connector-scoped credentials.
7. Outcome and artifacts are logged to ledgers.
8. Evidence pack is available immediately for audit/review.
9. Metrics and feedback update trust models and policy tuning suggestions.

## What “AI Does Everything” Means
It does not mean unbounded control. It means bounded autonomy with measurable safety.

### Bounded autonomy principles
- Every action is pre-classified by risk and allowed scope.
- Every execution path is policy-checked before side effects.
- Every external effect is idempotent and replay-safe.
- Every workflow state transition is ledgered.
- Every incident can trigger org-level safe mode.
- Every chat-triggered command has explicit intent parsing, plan preview, and user confirmation when side effects are possible.

### Approval model in end state
- Low risk: pre-approved by policy + budget envelope.
- Medium risk: sampled approval or delayed audit (configurable).
- High risk: explicit human approval required.
- Critical risk: blocked unless incident commander overrides.

## Failure and Exception Handling

### Failure categories
- Deterministic policy blocks (expected).
- Connector/runtime failures (retryable/non-retryable).
- Ambiguity/conflict in AI plan.
- Anomaly drift (sudden trust drop / policy spike).

### Failure behavior
- Stop further side effects for affected workflow.
- Emit incident events with reason codes.
- Open exception task with remediation options.
- Preserve full replay context (inputs, model output, policy result, action response).
- Auto-fallback to lower autonomy level when threshold breaches are detected.
- For chat failures, AI must return:
  - what it understood
  - which step failed
  - safest next action (retry/manual/escalate)

## Multi-Tenant Operating Model
- Org is the hard isolation boundary.
- Connector identities and secrets are per-org (`connector_accounts`).
- Policies, risk budgets, and autonomy settings are org-scoped.
- Telemetry supports aggregate benchmarking without tenant data leakage.

## Strategic Outcome
By year 10, AI Agent OS is the default enterprise automation governance layer: workflows are mostly autonomous, humans intervene by exception, and audit confidence remains first-class.

## Backoffice Native OS Extension (Adopted)

This product explicitly targets backoffice execution domains:
- accounting
- finance operations
- general affairs
- procurement
- legal operations (document/approval-heavy paths first)

### Core experience to optimize
- AI receives and detects work (not only user-entered tasks).
- AI understands source documents/events, plans work, and executes eligible actions.
- Humans primarily handle:
  - approvals for high-risk operations
  - exception resolution
  - policy and governance tuning

### Operating principles added
- Multi-agent specialization is first-class:
  - executor agents (process/act)
  - verifier/auditor agents (challenge/check)
- Every decision must carry evidence anchors:
  - source artifact reference
  - applied rule/policy reference
  - prior-case reference where applicable
- Exception handling is a core throughput path:
  - system should recover missing data, ask targeted questions, and continue flow.

## Rational Scope Alignment (Adopt / Defer / Not target now)

### Adopt now (aligned with current architecture)
- Event-driven task discovery and planner-led proactive proposals.
- Unified case/task ledger with end-to-end traceability.
- Policy-first execution gates and approval controls.
- Audit-ready evidence output as default artifact.
- Per-org connector identity/config and strict org isolation.

### Defer to phased rollout (not removed)
- Bank write operations and high-impact financial side effects.
- Fully autonomous legal decisioning beyond rule-bounded operations.
- Broad ERP coverage before robust connector governance and conformance tests.

### Not target as primary product behavior
- Unbounded single-agent autonomy without role separation.
- Opaque decisioning without recoverable evidence anchors.
- “Autopilot first” in high-risk domains without risk/trust/budget gates.
