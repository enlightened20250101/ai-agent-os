# Risk and Trust Model

## Purpose
Risk and trust scoring determines whether AI actions are:
- auto-executed
- approval-gated
- blocked

The model is deterministic-first and explainable from day one.

## Action Risk Score

### Score range
- 0-100 (higher is riskier).

### Dimensions and weights (initial)
- Data sensitivity (0-30)
- Monetary impact (0-25)
- Externality / customer-facing impact (0-20)
- Reversibility (0-15)
- Past reliability context (0-10)

`risk_score = weighted_sum(dimensions)`

### Dimension definitions

#### 1) Data sensitivity (0-30)
- 0: no sensitive data
- 10: internal non-sensitive
- 20: PII-like content detected
- 30: financial/legal/credential-bearing data

Input sources:
- policy checks (`POLICY_CHECKED` reasons)
- action payload classifiers

#### 2) Monetary impact (0-25)
- 0: no spend/commitment
- 10: low implied impact
- 20: medium spend or contractual implication
- 25: high spend/financial transfer

#### 3) Externality (0-20)
- 0: internal-only action
- 10: vendor-facing routine communication
- 20: customer/public-facing consequence

#### 4) Reversibility (0-15)
- 0: fully reversible
- 8: partially reversible
- 15: irreversible side effects

#### 5) Past reliability context (0-10)
- 0: high recent reliability for this action path
- 10: repeated failures/corrections recently

## Agent and Connector Trust Score

### Score range
- 0.00-1.00 (higher is more trusted).

### Inputs
- Historical success rate (rolling windows)
- Human correction/rejection rate
- Policy violation frequency
- Incident involvement frequency
- Drift trend (rapid deterioration penalty)

### Suggested formula
`trust = 0.40*success_rate + 0.20*(1-correction_rate) + 0.20*(1-violation_rate) + 0.20*(1-incident_rate)`

Then apply trend penalty if recent 7-day drop exceeds threshold.

### Subjects scored
- `agent` (role behavior quality)
- `connector_account` (provider reliability and integration health)
- optional `workflow_template` trust

## Decision Matrix: Risk + Trust -> Approval Requirement

### Baseline thresholds
- Low risk: `risk_score < 30`
- Medium risk: `30 <= risk_score < 60`
- High risk: `risk_score >= 60`

- High trust: `trust >= 0.85`
- Medium trust: `0.65 <= trust < 0.85`
- Low trust: `trust < 0.65`

### Routing policy
- Low risk + high trust:
  - L3+: auto-execute if policy pass and budgets available
- Low risk + medium/low trust:
  - require single approval
- Medium risk + high trust:
  - sampled approval (e.g., 1 in N) or explicit approval by org setting
- Medium risk + medium/low trust:
  - explicit approval required
- High risk (any trust):
  - explicit approval or block based on policy
- Critical policy block:
  - always block

## Explainability Requirements
Every routing decision must store:
- final risk score + per-dimension contributions
- trust score + factors
- matched policy rules
- threshold values used
- final gate decision (`auto_execute`, `require_approval`, `block`)

Persist this in structured payloads (`RISK_SCORED`, `TRUST_EVALUATED`, `APPROVAL_BYPASSED`, `POLICY_CHECKED`).

## Reliability and Safety Constraints
- Do not allow risk/trust scoring to bypass explicit hard policy blocks.
- Unknown/missing risk inputs default to conservative path (approval required).
- Trust scores decay over time if fresh evidence is unavailable.
- Temporary incident mode overrides force stricter thresholds.

## Operational Controls
- Org-level knobs:
  - risk thresholds
  - approval sampling ratio
  - max auto-execution per period
  - connector-specific caps
- Alerting:
  - risk spike
  - trust drop
  - unexpected approval bypass volume
  - repeated policy violation bursts

## Audit Expectations
Evidence pack should include risk/trust decision snapshots for executed actions at L3+.
This creates defensible proof of “why this action ran automatically.”
