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

### 2026-03-05 - Evidence Pack format for MVP

- Decision: Provide a print-friendly authenticated HTML evidence report per task with structured sections plus raw event/action JSON via collapsible blocks.
- Why: Delivers audit-readiness immediately without introducing PDF generation complexity.

### 2026-03-05 - Action runner idempotency and concurrency guard

- Decision: Add `actions.idempotency_key` with unique `(org_id, idempotency_key)` constraint and enforce single `running` action per task, emitting `ACTION_SKIPPED` when execution is deduped or blocked.
- Why: Prevents duplicate Gmail sends under retries/concurrent clicks while keeping all skipped decisions auditable in the event ledger.

### 2026-03-05 - Org-scoped connector configuration

- Decision: Use `connector_accounts` as primary runtime source for Slack/Google credentials per org, with env vars as fallback for local/dev when no DB connector is configured.
- Why: Enables tenant-specific connector isolation while preserving zero-friction local setup.

### 2026-03-05 - Connector secrets handling in MVP

- Decision: Store connector secrets in `connector_accounts.secrets_json` as plain JSON for MVP, and mask secret inputs in UI forms.
- Why: Prioritizes delivery speed for the wedge; encryption-at-rest and secret manager integration are tracked as future hardening work.

### 2026-03-05 - Google connector OAuth flow

- Decision: Use Google OAuth authorization code flow (`/api/google/auth` -> `/api/google/callback`) to capture org-scoped `refresh_token` and sender email, while keeping `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in env only.
- Why: Removes manual refresh token handling from operators, improves security posture, and keeps runtime credentials tenant-scoped in `connector_accounts`.

### 2026-03-05 - OAuth state persistence for ngrok/local reliability

- Decision: Persist Google OAuth state as single-use rows in `google_oauth_states` (nonce + org/user binding + expiry + consumed_at), and verify/consume from DB in callback.
- Why: Eliminates cross-domain cookie mismatch issues (localhost vs ngrok), improves replay protection, and makes callback failures diagnosable with explicit error codes.

### 2026-03-05 - Canonical Google redirect URI + callback observability

- Decision: Canonicalize redirect URI through `getGoogleRedirectUri()` (`APP_BASE_URL` normalized, deprecated redirect envs as fallback only), and add `error_id` + step-based server logs for OAuth callback failures.
- Why: Prevents redirect mismatch drift, improves debugging of 307->not-connected failures, and gives actionable UI error feedback without exposing secrets.

### 2026-03-05 - Sender email detection fallback for Google OAuth

- Decision: Detect sender email via Gmail profile first, then OpenID Connect `userinfo` fallback (`openid email` scope requested).
- Why: Avoids false "not connected" outcomes when Gmail profile endpoint is unavailable/scoped differently in a project while still deriving a reliable sender identity.

### 2026-03-05 - Gmail MIME encoding hardening

- Decision: Encode non-ASCII subjects using RFC 2047 and send UTF-8 body as base64 with explicit `Content-Transfer-Encoding: base64`.
- Why: Prevents mojibake for Japanese and other multibyte text across common mail clients.

### 2026-03-05 - UI polish pass

- Decision: Apply a lightweight global visual system update (improved typography, app shell/nav clarity, and elevated card styling) without changing core workflows or labels.
- Why: Improves daily usability and perceived quality while keeping existing E2E flow stable.

### 2026-03-05 - Autonomous Task Proposer MVP

- Decision: Add periodic planner runs that generate org-scoped `task_proposals`, but keep humans in control by requiring explicit accept/reject before converting into executable tasks.
- Why: Reduces repetitive operator work while preserving existing approval and action-runner safety gates.

### 2026-03-05 - Planner trigger model

- Decision: Provide both in-product manual trigger (`/app/planner`) and cron-friendly endpoint (`/api/planner/run`) protected by `PLANNER_RUN_TOKEN` outside development.
- Why: Enables immediate MVP usage and easy future automation via GitHub Actions/external schedulers.

### 2026-03-05 - MVP Japanese localization

- Decision: MVPのユーザー向けUI文言と主要エラーメッセージを日本語化し、イベントタイプや内部ステータス値は英語のまま維持する。
- Why: 運用者の利用言語に合わせつつ、監査ログ・DB値・E2Eの安定性を保つため。

### 2026-03-05 - Next-generation roadmap assumptions

- Decision: L0->L4の段階的自律化を採用し、L3以降も hard policy block は常に優先（リスク/信頼スコアで上書き不可）とする。
- Why: 安全性・監査可能性を維持しながら自律化率を高めるため。

- Decision: オーケストレーションは `workflow_runs/workflow_steps` ベースの明示的ステートマシンへ移行し、既存 `task_events/actions` を監査台帳の中核として継続利用する。
- Why: 既存実装との互換性を保ったまま多段ワークフローと例外制御を拡張できるため。

- Decision: 自律実行の判断は `risk_score + trust_score + budget` の3軸で行い、組織単位で閾値と承認ルールを設定可能にする。
- Why: マルチテナント環境で安全性と運用柔軟性を両立するため。

- Decision: 小規模チーム向けに1-2週間単位の6フェーズ実装計画を採用し、各フェーズで migration + RLS + UI + E2E を同時に完了条件にする。
- Why: AI支援開発での実装速度を維持しつつ、品質劣化と後戻りコストを防ぐため。

### 2026-03-05 - Phase 1 proposal triage foundation

- Decision: `task_proposals` に `planner_run_id`, `priority_score`, `estimated_impact_json`, `decision_reason` を追加し、プランナーで優先度/影響度を計算して保存する。
- Why: 提案の運用優先順位を明示し、accept/reject判断の一貫性と監査性を高めるため。

- Decision: `/api/planner/runs/[id]` を追加し、orgスコープで planner run と関連 proposals の診断JSONを返す。
- Why: Planner品質改善時の運用デバッグをUI依存なしで実施できるようにするため。

### 2026-03-05 - Phase 2 workflow orchestrator baseline

- Decision: `workflow_templates/workflow_runs/workflow_steps` を追加し、タスクに対する実行を明示的ステートマシンで管理する。
- Why: 多段処理の進捗・再実行・監査を ad-hoc 実装から分離し、L3/L4へ拡張可能な実行基盤を先に作るため。

- Decision: 初期の workflow 実行は `start` と `advance` の手動進行モデルで提供し、各ステップを `WORKFLOW_*` イベントとして task ledger に記録する。
- Why: 安全な段階移行のため、まずは可観測性と状態整合性を確立し、その後自動遷移を追加するため。

- Decision: migration 未適用環境でも既存フローを壊さないため、workflow 関連クエリ/書き込みには missing table/column フォールバックを入れる。
- Why: 開発中の段階導入で E2E と運用継続性を維持するため。

### 2026-03-05 - Phase 3 governance baseline (risk/trust/budget)

- Decision: `org_autonomy_settings`, `risk_assessments`, `trust_scores`, `budget_limits`, `budget_usage` を追加し、組織ごとの自律レベルと実行予算をDBで管理する。
- Why: L3以降の自動実行判定を設定可能かつ監査可能にするため。

- Decision: `evaluateGovernance` を導入し、`policy + risk_score + trust_score + budget` の合議で `allow_auto_execute | require_approval | block` を返す。
- Why: 単一条件に依存しない安全な承認バイパス判定を実現するため。

- Decision: 自動実行はデフォルト無効とし、`L3/L4` かつ `auto_execute_google_send_email=true` かつ閾値内の場合のみ `APPROVAL_BYPASSED` を記録して実行を許可する。
- Why: 既存の承認中心運用を維持しつつ、明示的オプトインで段階的に自律化を進めるため。

### 2026-03-05 - Planner API batch mode for cron

- Decision: `POST /api/planner/run` は `org_id` 指定時の単一実行に加え、`org_id` 省略時は `orgs` を最大 `max_orgs` 件巡回実行する batch mode をサポートする。
- Why: 外部cron/GitHub Actionsから単一ジョブで複数orgを定期実行できるようにし、運用自動化の初期負荷を下げるため。

### 2026-03-05 - Workflow step executor baseline

- Decision: workflow step type `execute_google_send_email` をオーケストレータに実装し、step開始時に Gmail Action Runner を実行する。
- Why: L3に向けて「テンプレート駆動の実行」と「既存アクション実行基盤」を統合し、手動サーバーアクション依存を減らすため。

- Decision: workflow経由のメール送信でも `policy + governance + idempotency + concurrency` を適用し、失敗時は `workflow_steps=failed` / `workflow_runs=failed` / `WORKFLOW_FAILED` を記録する。
- Why: 自律実行パスでも監査性と安全性を manual 実行と同等に保つため。

### 2026-03-05 - Budget edit UI (MVP)

- Decision: `/app/governance/budgets` に `google/send_email` 日次上限の編集フォームを追加し、`budget_limits` を org スコープ upsert で更新する。
- Why: 自律実行の安全運用で最も重要な実行量制御を、SQL操作なしで運用者が調整できるようにするため。

### 2026-03-05 - Workflow failure-path E2E coverage

- Decision: Playwrightに workflow失敗系シナリオ（未承認タスクで `execute_google_send_email` 実行 -> `workflow_runs.status=failed` -> `WORKFLOW_FAILED` 記録）を追加する。
- Why: 自律実行で最も重要な「危険時に止まる」挙動を継続的に回帰テストで担保するため。

### 2026-03-05 - Workflow failed-step retry UX

- Decision: failed な workflow run に対して `retryFailedWorkflowRun` を追加し、失敗ステップを `running` に戻して再試行できるUIボタンを run detail に配置する。
- Why: オペレーターが失敗理由を確認して即座に復旧できる運用導線を用意し、ワークフロー停止時間を短縮するため。

### 2026-03-05 - E2E retry navigation synchronization

- Decision: Playwright の retry 検証はボタンクリック後に `/app/workflows/runs/:id?ok=...` または `?error=...` への遷移完了を必須待機してから task detail へ戻る。
- Why: Server Action の非同期リダイレクト競合で task 画面確認が先走る flaky failure を防ぎ、`WORKFLOW_RETRIED` イベント検証を安定化するため。

### 2026-03-05 - Incident mode circuit breaker (MVP)

- Decision: `org_incidents` を追加し、open incident が1件でも存在する org は `evaluateGovernance` で強制 `block` 判定にする。
- Why: 障害・誤送信リスク発生時に、設定値やモデル判断に依存せず自動実行を即時停止できる運用安全装置が必要なため。

- Decision: `/app/governance/incidents` で宣言/解決を運用可能にし、`INCIDENT_DECLARED` / `INCIDENT_RESOLVED` を system task ledger に記録する。
- Why: 緊急停止の発動/解除を UI から即実施でき、監査時に責任追跡可能な証跡を残すため。

### 2026-03-05 - Trust score auto-update from execution outcomes

- Decision: `recordTrustOutcome` を追加し、`google/send_email` の Action 実行結果（success/failed）ごとに `trust_scores` へ新しいスナップショット行を追記する。
- Why: 自律判定で使う trust を静的設定ではなく実績ベースにし、継続運用で自動実行の精度を改善するため。

- Decision: trust更新は本処理の失敗要因にしない（失敗時はログ出力のみ）。
- Why: メール実行やワークフロー本体の可用性を優先し、補助メトリクス更新障害で主要フローを止めないため。

- Decision: 承認却下（`HUMAN_REJECTED`）時にも、対象ドラフトが `google/send_email` なら trust を失敗側に補正する。
- Why: 人間による差し戻しを「自律判断の不一致シグナル」として学習し、過度な自動実行を抑制するため。

- Decision: `/app/governance/trust` を追加し、最新スナップショットと直近履歴（metadata含む）を可視化する。
- Why: trust 閾値運用をブラックボックス化せず、運用者が理由を確認しながら調整できるようにするため。

- Decision: Trust画面に期間フィルタ（7/30/90/365日）と role_key フィルタ、success/failed 件数サマリーを追加する。
- Why: 閾値調整時に「最近の挙動」と「担当ロール別の傾向」を短時間で把握できる運用性を優先するため。

- Decision: Trust画面に `provider/action_type` フィルタと `min_trust_score` 差分表示を追加する。
- Why: 実行種別ごとの自律可否ギャップを即時に可視化し、しきい値調整・原因切り分けの時間を短縮するため。

### 2026-03-05 - Dashboard-first UI readability pass

- Decision: `TOP(/app)` と `tasks/approvals/planner` に軽量ダッシュボード可視化（KPIカード、ステータス分布バー、7日サマリー）を追加する。
- Why: 運用者が詳細ページに入る前に全体状態とボトルネックを把握できるようにし、日次オペレーションの確認コストを下げるため。

- Decision: 可視化バーは縦棒を標準とし、`0件` は棒を描画しない。緊急度の高い指標（failed/pending/incident/policy block）は警戒色で強調する。
- Why: 運用画面での視線誘導と異常検知速度を優先し、ノイズとなるゼロ値の棒を排除するため。

- Decision: SPヘッダーは1行上段（ロゴ/ログアウト）+ 1行横スクロールナビに再構成し、メール表示は省スペース化する。
- Why: モバイルでのヘッダー占有面積を削減し、ファーストビューで主要コンテンツが見える量を増やすため。

### 2026-03-05 - Governance recommendations center (MVP)

- Decision: `/app/governance/recommendations` を追加し、インシデント・承認滞留・実行失敗率・policy block・trust低下・予算残量を横断集計して優先度付き改善提案を表示する。
- Why: 自律運用を拡大する上で、運用者が「次に何を直すべきか」を即時判断できる導線が必要なため。

- Decision: 提案優先度は `critical/high/medium/low` の4段階とし、縦棒分布・緊急色・アクションリンクをセットで提示する。
- Why: 監視ダッシュボードだけでは対処が遅れるため、可視化と実行導線を同画面で提供して改善サイクルを短縮するため。

- Decision: `TOP(/app)` に `critical/high` 件数カードと「AI改善提案（上位3件）」ウィジェットを常設する。
- Why: 運用者がホーム滞在中に優先課題を即把握し、ガバナンス改善ページへ最短遷移できるようにするため。

- Decision: 改善提案の一部をワンクリック実行可能にする（`trust低下/失敗急増 -> auto_execute_google_send_email=false`、`承認滞留 -> Slack催促送信`）。
- Why: 観測だけでなく即時の安全対策を実行できるようにし、異常時の初動時間を短縮するため。

- Decision: 改善提案実行時に `baseline_summary`（適用時点メトリクス）を `GOVERNANCE_RECOMMENDATION_APPLIED` payload に保存し、画面で現在値との差分を表示する。
- Why: 改善施策の効果検証をイベント台帳だけで追跡可能にし、運用改善のPDCAを回しやすくするため。

- Decision: 実行履歴には差分値に加えて `improved / worsened / mixed / flat` バッジを表示し、低いほど良い指標（failed/pending/incidents）で判定する。
- Why: 値の読み取りコストを下げ、施策の成否を数秒で判断できるようにするため。

- Decision: 改善提案履歴に `actor_id/actor_type` と `followup_href` を表示し、実行者トレースと後続オペレーション導線を同時提供する。
- Why: 監査性（誰が適用したか）と運用性（次の画面に即遷移）を両立するため。

- Decision: 改善提案の危険操作（`disable_auto_execute`）は確認チェック（`confirm_risky=yes`）を必須化し、未確認時はサーバー側で拒否する。
- Why: UI操作ミスによる意図しない運用モード変更を防ぐため。

- Decision: Playwright E2Eに改善提案の危険操作検証（未チェックで拒否 -> チェック後成功）を追加する。
- Why: セーフティガードの回帰を継続的に防ぐため。

- Decision: 改善提案アクション失敗時は `GOVERNANCE_RECOMMENDATION_FAILED` を ledger に記録し、`retry_action_kind/retry_recommendation_id` をURLに付けて再試行フォームを表示する。
- Why: 失敗の監査証跡を残しつつ、運用者が即時に同一操作をリトライできるようにするため。

- Decision: 改善提案の実行履歴に `action_kind` / `result(success|failed)` フィルタを追加する。
- Why: 提案運用の失敗傾向分析と改善優先度付けを短時間で行えるようにするため。

- Decision: `POST /api/governance/recommendations/run` を追加し、org単位または全orgバッチで改善提案再評価を実行して `GOVERNANCE_RECOMMENDATIONS_REVIEWED` を台帳記録する。
- Why: 日次cron運用で改善提案の鮮度を維持し、運用者が最新シグナルを元に対処できるようにするため。

- Decision: `/app/governance/recommendations` に「今すぐ再評価」ボタンと「最新レビュー結果」セクションを追加する。
- Why: 手動運用時でも即時リフレッシュと結果確認を1画面で完結させるため。

- Decision: `.github/workflows/autonomy-cron.yml` を追加し、30分間隔で planner batch と governance recommendations review batch を順次実行する。
- Why: 人手の起動操作なしで提案・改善シグナルを継続更新し、L2/L3運用の鮮度を維持するため。

- Decision: `/app/operations/jobs` を追加し、`planner_runs` と `GOVERNANCE_RECOMMENDATIONS_REVIEWED/FAILED` イベントを同一画面で監視可能にする。
- Why: cron運用の成否をアプリ内で追跡し、失敗時の一次切り分けを迅速化するため。

- Decision: governance recommendations review の失敗時は `GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED` を system event として記録する。
- Why: バッチ失敗をレスポンスログだけに依存せず、監査可能なイベント台帳に残すため。

- Decision: `/app/operations/jobs` に `失敗のみ表示` フィルタと、planner/review の失敗詳細 JSON 展開（`<details>`）を追加する。
- Why: 障害調査時にノイズを減らし、根本原因に最短で到達できるようにするため。

- Decision: ジョブ履歴に `直近失敗からの経過時間` と `連続失敗回数` を追加表示する。
- Why: 障害の継続性と緊急度を一目で判断し、エスカレーション判断を高速化するため。

- Decision: `TOP(/app)` にジョブ連続失敗バナーを追加し、`planner` または `governance review` が2連続失敗以上の場合に `failed_only=1` 付きジョブ履歴へ誘導する。
- Why: オペレーターがホーム画面の時点で異常を即検知し、障害調査画面へ1クリックで遷移できるようにするため。

- Decision: ヘッダー直下（全 `/app/*`）にも同条件のミニ異常バナーを表示し、任意ページ滞在中でもジョブ連続失敗を即認知できるようにする。
- Why: TOP以外の画面作業中に異常を見落とさないため。

- Decision: ヘッダーミニ異常バナーに `planner/review` の最終失敗時刻を併記する。
- Why: 失敗の新鮮度（いま起きた障害か、過去障害か）を瞬時に判断できるようにするため。

- Decision: `ENABLE_OPS_SLACK_ALERTS=1` のとき、`/api/governance/recommendations/run` 実行後に連続失敗閾値を評価し、超過時はSlackへ運用アラートを投稿する。
- Why: 異常を画面確認待ちにせず、運用チャネルへ能動通知して初動を短縮するため。

- Decision: Opsアラートは30分バケット + 失敗件数をキーに重複抑止し、`OPS_ALERT_POSTED/OPS_ALERT_FAILED` を台帳に記録する。
- Why: 通知スパムを防ぎつつ、通知成否自体を監査可能にするため。

- Decision: `/app/operations/jobs` に `OPS_ALERT_POSTED/FAILED` 履歴セクションを追加し、`failed_only=1` フィルタに連動させる。
- Why: 通知結果（送信成功/失敗）と通知時ヘルス情報をUI上で追跡できるようにするため。

- Decision: Ops Alert投稿時に `chat.getPermalink` をbest-effortで取得し、`task_events.payload_json.slack_permalink` に保存してジョブ履歴から直接遷移可能にする。
- Why: 通知の存在確認だけでなく、実際のSlackメッセージ内容へ即アクセスできる運用性を確保するため。

- Decision: `/app/operations/jobs` に `Opsアラートを手動再送` ボタンを追加し、`maybeSendOpsFailureAlert(force=true, source=manual)` を実行できるようにする。
- Why: 重大障害時にしきい値待ちや dedupe 待ちをせず、運用者が即時に再通知できるようにするため。

- Decision: Ops Alert履歴に `alert_key` を明示表示する。
- Why: 重複抑止（dedupe）で通知が1件に集約される挙動を、運用画面から追跡可能にするため。

- Decision: `/api/governance/recommendations/run` のレスポンスにも `alert_key` を返す。
- Why: GitHub Actions などの実行ログとアプリ内イベント履歴を同じキーで突合できるようにするため。

- Decision: `autonomy-cron.yml` は API レスポンスJSONを整形出力し、governance review 実行時に `org_id / alert_reason / alert_key` サマリーをログ出力する。
- Why: 運用者がCIログ上で通知有無と dedupe 状態を即把握できるようにするため。

- Decision: `autonomy-cron.yml` の planner/review API呼び出しに簡易リトライ（最大2回、5秒待機）を追加する。
- Why: 一時的なネットワーク不安定や短時間障害でジョブ全体が即失敗しないようにするため。

- Decision: `autonomy-cron.yml` のリトライ回数/待機秒は GitHub Actions Variables (`AUTONOMY_API_RETRY_COUNT`, `AUTONOMY_API_RETRY_WAIT_SECONDS`) で調整可能にする。
- Why: 環境ごとのAPI安定性に合わせて、コード変更なしで運用パラメータを調整できるようにするため。

- Decision: Slackコネクタ設定UIに `alert_channel_id` 入力を追加し、Opsアラート通知先を org 単位で分離可能にする。
- Why: 承認通知チャネルと運用アラートチャネルを分離できるようにし、通知ノイズ管理を改善するため。

- Decision: Slack連携画面に `Opsアラート テスト送信` ボタンを追加し、alert経路の疎通をUIから検証可能にする。
- Why: cron待ちや障害発生を待たずに、運用通知経路の初期確認を短時間で完了させるため。

- Decision: `/app/operations/jobs` のKPIに `manual resend (30)` を追加し、直近30件の `OPS_ALERT_POSTED(source=manual)` 件数を可視化する。
- Why: 自動通知だけでなく、運用者の介入頻度（手動再送の多さ）を先行指標として把握し、しきい値や監視設計の見直し判断に使えるようにするため。

- Decision: ワークフローの自律前進のため、`POST /api/workflows/tick` を追加し、`workflow_runs(status=running)` を org 単位でバッチ進行できるようにした（本番は `WORKFLOW_TICK_TOKEN`、未設定時は `PLANNER_RUN_TOKEN` を利用）。
- Why: 手動の「進める」操作に依存せず、承認済み後続ステップを定期ジョブで継続実行して自律化を前進させるため。

- Decision: `/app/operations/jobs` に `Workflow Tick実行` ボタンを追加し、運用者がUIから即時にワークフローキューを消化できるようにした。
- Why: cron待ちをせずに滞留を解消し、障害時の一次切り分け（手動で進むか）を短時間で行えるようにするため。

- Decision: 連続失敗に対する安全弁として、自動インシデント判定 (`evaluateAndMaybeOpenIncident`) を追加し、planner/review の連続失敗または `ACTION_FAILED` バーストで `org_incidents` を自動宣言する。
- Why: 人手監視に依存せず Safe Mode へ移行し、L3/L4運用時の暴走リスクを早期遮断するため。

- Decision: 自動インシデントの監査台帳として `incident_events` テーブルを追加し、`INCIDENT_AUTO_DECLARED` を記録する。
- Why: インシデントが「なぜ」「どの閾値で」開いたかを task_events とは独立に追跡し、監査/事後分析を容易にするため。

- Decision: `/api/incidents/auto-open` を追加し、GitHub Actions cron から org バッチ実行できるようにした（token guard付き）。
- Why: 手動UI操作なしで定期的に安全判定を実行し、自律運用の停止判断を自動化するため。

- Decision: `/app/operations/jobs` に `自動インシデント判定` ボタンと Auto Incident履歴セクションを追加した。
- Why: 運用者がUIから即時に安全判定を再実行し、直近の自動宣言トリガーを可視化できるようにするため。

- Decision: `/app/operations/exceptions` を新設し、`failed actions / failed workflow runs / stale pending approvals / policy-blocked tasks` を単一画面でトリアージ可能にした。
- Why: 例外対応の起点を集約し、L3/L4運用で人間が介入すべき案件を最短で処理できるようにするため。

- Decision: 例外キューから `retryFailedWorkflowRun` を直接実行できる server action を追加した。
- Why: ワークフロー失敗時に run 詳細画面へ遷移せず復旧操作を実行でき、MTTRを短縮するため。

- Decision: 例外キューに簡易 priority score（P0-100相当）を導入し、failed action/workflow・承認滞留・policy block を優先順に並べる。
- Why: 例外が増えたときに“どれから対応すべきか”を即判断できるようにし、運用の意思決定コストを下げるため。

- Decision: 例外キューに `上位N件の失敗workflow一括再試行` を追加した（既存 `retryFailedWorkflowRun` を再利用）。
- Why: 障害復旧時の反復操作を削減し、再試行の初動を短縮するため。

- Decision: 例外対応の運用管理用に `exception_cases` テーブルを追加し、例外キー（kind/ref_id）単位で `owner_user_id` と `status(open/in_progress/resolved)` を保持する。
- Why: 例外キューが閲覧専用だと対応漏れが発生するため、担当と進捗を永続化して責任追跡を可能にするため。

- Decision: 例外キュー各行に `status/owner/note` 編集フォームを追加し、未登録ケースは upsert で自動作成する。
- Why: 画面遷移なしで最小操作でトリアージ更新できるようにし、運用負荷を下げるため。

- Decision: `exception_cases` に `due_at` と `last_alerted_at` を追加し、期限超過・未割当の未解決ケースを Slack 通知対象とする。
- Why: 例外ケースの放置を防ぎ、SLA違反の早期検知を自動化するため。

- Decision: `notifyExceptionCases` と `POST /api/operations/exceptions/alerts` を追加し、UI手動実行とcron実行の両方で例外通知できるようにする。
- Why: 日中運用だけでなく定期監視でも例外を拾い上げ、オペレーションの追跡漏れを減らすため。

- Decision: 例外キューに「未解決件数 / 期限超過件数 / 最大期限超過時間」と「担当者別バックログ」を追加した。
- Why: 単票ベースの確認だけでなく、運用負荷の偏りとSLA劣化を集計視点で即把握できるようにするため。

- Decision: 例外キューに `owner / case_status / overdue_only` フィルタを追加し、一覧・KPI・優先対応リストを同一条件で絞り込むようにした。
- Why: ケース数が増えた際に担当者や状態別のオペレーションを素早く切り替え、ノイズを減らして対応速度を上げるため。

- Decision: 例外キューに `sort(priority_desc|due_asc|updated_desc)` と `view` プリセット（`all`, `overdue_unassigned`, `my_open`）を追加した。
- Why: オペレーション目的別の表示切替をURLで再現可能にし、引き継ぎや共有時の再現性を高めるため。

- Decision: 例外キューに `選択ケース一括更新` を追加し、複数ケースの `status/owner/due` をまとめて更新可能にした。
- Why: 大量アラート時の手動更新回数を減らし、トリアージ処理速度を改善するため。

- Decision: 例外キューの現在フィルタ条件を引き継ぐ CSV エクスポート (`/api/operations/exceptions/export`) を追加した。
- Why: 週次レビューや外部共有向けに、画面上の絞り込み結果をそのまま再利用できる監査データ出力を提供するため。

- Decision: `exception_case_events` テーブルを追加し、ケース作成/更新/一括更新/通知送信を append-only で記録する。
- Why: 例外対応の責任追跡（誰がいつ何を変更したか）を監査可能にし、運用レビューの再現性を高めるため。

- Decision: Evidence Pack (`/app/tasks/[id]/evidence`) にタスク紐づき `exception_cases` と `exception_case_events` の監査セクションを追加した。
- Why: 実行・承認だけでなく例外対応の履歴まで1つの証跡に統合し、監査レビュー時の追跡工数を削減するため。

- Decision: Playwright主要E2Eに Evidence Pack の例外監査セクション (`例外ケース監査`, `Exception Case Events`) の表示アサーションを追加した。
- Why: 例外監査統合が今後のUI変更で欠落しないよう、回帰検知を自動化するため。

- Decision: 例外キューCSVに `exception_case_events` 要約列（件数・最新イベント種別/時刻/ペイロード）を追加した。
- Why: ケース状態だけでなく直近の操作履歴までCSV上で確認できるようにし、監査提出時の情報欠落を防ぐため。

- Decision: 例外CSVの先頭に `# exported_at / # filter_* / # row_count` のメタ情報行を追加した。
- Why: 出力条件と件数をCSV単体で自己完結させ、監査提出時の再現性と説明可能性を高めるため。

- Decision: 例外エクスポートAPIに `format=json` を追加し、CSVと同等のフィルタ/ソート結果とメタ情報をJSONで返すようにした。
- Why: BI連携や自動処理パイプラインでの再利用性を高めるため。

- Decision: 例外キュー画面のフィルタバーに `JSONエクスポート` ボタンを追加し、現在条件で `format=json` を直接取得できるようにした。
- Why: API URLを手で組み立てずに機械可読データを取得できるようにして、運用者の作業手順を短縮するため。

- Decision: 例外エクスポートAPIに `limit` / `offset` を追加し、CSV/JSONの両形式でページング取得を可能にした。
- Why: 件数増加時でもレスポンスサイズを制御しながら段階的にデータ取得できるようにするため。

- Decision: 例外キュー画面に `export_limit` / `export_offset` 入力を追加し、CSV/JSONエクスポートボタンへ反映するようにした。
- Why: UI操作のみで大規模データの分割エクスポートを実行できるようにし、運用手順を簡素化するため。

- Decision: 例外エクスポートに `include_payload=0|1` を追加し、最新イベントpayload列の出力有無を切り替え可能にした。
- Why: 大規模データ時にレスポンスサイズを抑えつつ、必要時のみ詳細payloadを取得できるようにするため。

- Decision: エクスポートメタに `has_more` / `next_offset` を追加した。
- Why: ページング取得をクライアント側で継続処理しやすくするため。

- Decision: 例外エクスポートAPIに `x-export-token` (`EXCEPTION_EXPORT_TOKEN`) + `org_id` のサーバー間呼び出しモードを追加した。
- Why: セッションCookieに依存せず、運用バッチやCLIから安全にエクスポートできるようにするため。

- Decision: `scripts/export-exceptions-json.mjs` を追加し、`next_offset` を辿って全ページを結合出力するCLIを提供した。
- Why: 監査データ取得の反復作業を削減し、定常運用で再利用しやすくするため。

- Decision: 例外エクスポートCLIに `--resume-from` と `--shard-size` を追加した。
- Why: 大規模データ取得時に途中失敗からの再開を容易にし、巨大JSONを分割して保管/転送しやすくするため。

- Decision: planner/governance/workflow/incident/exception-alert のバッチAPI実行に共通リトライ (`OPS_JOB_RETRY_MAX_ATTEMPTS`, `OPS_JOB_RETRY_BACKOFF_MS`) を導入し、`OPS_JOB_RETRY_*` を `task_events` に監査記録する。
- Why: 一時的障害でジョブ全体が不安定になるリスクを下げ、再試行の成否と枯渇を証跡として追跡できるようにするため。

- Decision: `org_job_circuit_breakers` を追加し、同一job種別の連続失敗でサーキットを開いて一定時間スキップする仕組み（`OPS_JOB_CIRCUIT_BREAKER_*`）を導入した。
- Why: 障害継続時の無限再試行・ノイズ増大を防ぎ、運用者が復旧までの間に安定してトリアージできるようにするため。

- Decision: `/app/operations/jobs` にジョブ単位/全体のサーキット手動解除アクションを追加し、`OPS_JOB_CIRCUIT_MANUALLY_CLEARED` を task_events に記録する。
- Why: 障害復旧後にオペレーターが明示的に実行再開できる導線を提供し、再開判断の監査証跡を残すため。

- Decision: サーキット手動解除フォームに「解除理由」を追加し、`OPS_JOB_CIRCUIT_MANUALLY_CLEARED.payload_json.reason` として必須保存する（未入力時は `manual_clear`）。
- Why: なぜ再開したかの判断根拠を後から追跡できるようにし、運用品質レビューとインシデント振り返りを容易にするため。

- Decision: 運用ジョブ画面の監査イベント一覧で `OPS_JOB_CIRCUIT_MANUALLY_CLEARED` の解除理由をバッジ表示で強調する。
- Why: 監査レビュー時にJSONを展開しなくても再開判断の根拠を即確認できるようにするため。

- Decision: バッチ系APIはサーキットオープン時にHTTPエラーではなく `ok: true, skipped_circuit: true` を返し、org単位結果にも `paused_until` を含める。
- Why: 予定された一時停止を障害として扱わず、cron運用のノイズを減らしつつ停止状態を機械判定可能にするため。

- Decision: サーキット開放時に Slack 運用チャネルへ通知し、`OPS_JOB_CIRCUIT_ALERT_POSTED/FAILED` を台帳記録する（既存 `ENABLE_OPS_SLACK_ALERTS` ガードを再利用）。
- Why: 自動停止が発生したことを運用者へ即時に伝え、再開判断と復旧初動を早めるため。

- Decision: ジョブサーキットの復帰を `paused -> dry_run -> active` の2段階に変更し、復帰ゲートは「直近成功率」または「手動解除」のどちらかを必須にした。
- Why: 停止解除直後の誤復帰を防ぎ、段階的に安全確認してから本実行へ戻すため。

- Decision: 例外通知時に未割当ケースを既定担当者（owner優先）へ自動アサインし、`CASE_AUTO_ASSIGNED` を記録する。
- Why: 通知だけで担当不在のまま滞留する状態を減らし、一次対応の責任者を即時確定するため。

- Decision: 例外通知にSLAベースの段階エスカレーション（medium/high/critical）を導入し、`CASE_ESCALATED` を高優先ケースに記録する。
- Why: 期限超過の深刻度を運用チャネルで即判別できるようにし、対応優先度の判断を高速化するため。

- Decision: ジョブサーキット復帰の可観測性を高めるため、運用画面に `resume_stage / dry_run_until / last_error` を表示し、解除理由を必須入力にした。
- Why: 停止状態の解釈と再開判断の根拠を運用者がUI上で即確認できるようにするため。

- Decision: 例外キュー各カテゴリに「次アクション」と「回収質問テンプレ」を表示するガイダンスを追加した。
- Why: 例外対応を担当者依存の属人作業にせず、最短で回収・前進させる標準オペレーションを作るため。

- Decision: 例外ガイダンスは固定文ではなく、担当者・期限超過時間・対象タスク名を埋め込む動的テンプレートにした。
- Why: 現場が「今この案件で何をするか」を即判断できるようにし、対応の初動時間を短縮するため。

- Decision: Exception Case Events 一覧で `CASE_ESCALATED` と `CASE_AUTO_ASSIGNED` をバッジ強調表示する。
- Why: 高優先のエスカレーション発生と自動割当の実施有無を、監査一覧で瞬時に判別できるようにするため。

- Decision: E2E専用に `seed-job-circuit` API を追加し、`skipped_circuit` / `skipped_dry_run` を回帰テスト可能にした。
- Why: サーキット制御の安全ロジックが将来変更で壊れないよう、自動検証の入口を確保するため。

- Decision: Playwright設定で `.env.local` / `.env.e2e(.local)` を自動読込するようにし、E2E必須環境変数の読み込み漏れを抑止した。
- Why: CI/ローカル双方で `E2E_PASSWORD` などの不足起因の偽失敗を減らし、実フロー検証に集中するため。

- Decision: Playwright実行時に `E2E_PASSWORD` / `E2E_CLEANUP_TOKEN` が未設定ならローカル用デフォルト値を注入する。
- Why: 必須変数の未設定で全E2Eが開始直後に停止する状況を避け、回帰テストを継続実行できるようにするため。

- Decision: プロダクトの理想像を「AIネイティブ業務OS（バックオフィス実行OS）」として明示し、対象業務を事務・経理・総務・購買・法務オペレーションに拡張定義した。
- Why: 単機能自動化ではなく、業務実行・統制・監査を統合したOS価値をロードマップ全体で一貫させるため。

- Decision: 理想像のうち「役割分離（実行エージェント/監査エージェント）」「根拠アンカー」「例外回収を主戦場」は採用し、既存の event-ledger / evidence-pack を中核に段階実装する。
- Why: 既存アーキテクチャと整合しつつ、説明責任と運用品質を強化できるため。

- Decision: 高リスク金融操作の完全自律化（銀行書込など）は即時目標にせず、L3/L4の risk/trust/budget + SoD 統制成熟後に段階導入する。
- Why: 現行MVPの安全原則（approval-first, policy-first）と矛盾する先行自動化を避けるため。

- Decision: Slack Events API (`/api/slack/events`) を追加し、`app_mention` / `message` から `tasks` を自動起票する intake 導線を実装した。
- Why: 手動入力中心のL0運用から、イベント起点でAIが仕事を受け取る能動型運用へ段階的に移行するため。

- Decision: Slackイベント重複配信対策として `slack_event_receipts` テーブルを追加し、`event_id` unique による冪等受信を導入した。
- Why: Slack再送やネットワーク揺らぎ時の重複タスク起票を防ぎ、監査可能な受信履歴を保持するため。

- Decision: Slack intake の org 解決は `connector_accounts(provider='slack', external_account_id=team_id)` を優先し、env-only 運用時は `SLACK_DEFAULT_ORG_ID` をフォールバックにした。
- Why: マルチテナント分離を維持しつつ、ローカル/移行期の単一テナント運用も止めないため。

- Decision: `/app/proposals` に判断理由コード（decision_reason taxonomy）を導入し、受け入れ/却下時に `decision_reason` を `code[:note]` 形式で保存するようにした。
- Why: 提案品質の振り返りを自由入力テキストに依存させず、再現性のある運用メトリクスを残すため。

- Decision: 提案一覧に `decision_reason_prefix` フィルタと判断理由サマリ表示を追加した。
- Why: どの理由で採否されているかを運用画面で即時に把握し、planner改善の優先度付けをしやすくするため。

- Decision: `/app/planner` の実行履歴カードに `summary_json` を構造化表示し、`created_proposals / considered_signals / total_signal_items / signal_breakdown` を見える化した。
- Why: 単なる成功/失敗だけではなく、入力シグナル量と提案化結果の関係を運用者が即判断できるようにするため。

- Decision: `/app/tasks` に流入ソース（manual/slack/proposal/system）判定とフィルタを追加し、Slack intake由来タスクを即時抽出できるようにした。
- Why: 自動取り込み運用で「どこから来たタスクか」を可視化し、監視・優先対応・改善分析をしやすくするため。

- Decision: `/app` に「優先対応キュー」カードを追加し、滞留承認・24h失敗アクション・block提案・未判断提案を緊急色で可視化した。
- Why: 運用者が最初に手を付けるべき詰まりを1画面で把握し、例外処理中心の運用を加速するため。

- Decision: `E2E_MODE` で `x-e2e-cleanup-token` が正しい場合のみ、`/api/slack/events` に `e2e_org_id` 指定の署名バイパス経路を追加した。
- Why: 本番の署名検証を維持しつつ、PlaywrightでSlack外部依存なしに intake 起票フローを回帰検証するため。

- Decision: `/api/planner/runs/:id` を拡張し、`run_events (PLANNER_RUN_STARTED/FINISHED)` と `proposal_events` を合わせて返すようにした。
- Why: run単位で「何が生成され、どう判断されたか」をAPIレスポンスだけで追跡できる監査性を高めるため。

- Decision: プランナー実行前に直近採否データ（accept/reject率・上位却下理由）を集計し、`effective_max_proposals` を動的調整するフィードバック制御を追加した。
- Why: 却下が続く期間に提案量を自動で絞り、ノイズ提案の連発を抑えつつ人間レビュー負荷を下げるため。

- Decision: planner run `summary_json` に feedbackスナップショット（acceptance/rejection rate, top_reject_reasons, requested/effective max）を保存し、`/app/planner` で可視化した。
- Why: 「なぜその提案件数になったか」を運用者が後から説明できるようにし、改善ループを監査可能にするため。

- Decision: タスク詳細ヘッダーに起票ソース（manual/slack/proposal/system）バッジと `proposal_id` 表示を追加した。
- Why: 単一タスクの監査・原因調査時に、起票経路を即時判別できる導線を作るため。

- Decision: 提案受け入れ操作に「受け入れ+承認依頼」を追加し、受け入れ直後に `approvals` 作成 + `APPROVAL_REQUESTED`（必要なら Slack 投稿）まで自動実行する導線を追加した。
- Why: 提案採用後に別画面で承認依頼を作る手間を減らし、提案から実行準備までのリードタイムを短縮するため。

- Decision: `/app/proposals` に理由コード付き「一括却下」を追加し、選択した proposed 提案をまとめて `rejected` 更新 + `PROPOSAL_REJECTED` 記録するようにした。
- Why: ノイズ提案を個別処理する運用負荷を下げ、提案キューを短時間で健全化できるようにするため。

- Decision: `/app/approvals` に pending承認の経過時間バッジ（SLA超過判定）と「Slackに再通知」アクションを追加した。
- Why: 承認滞留を可視化し、承認者への再通知を1クリックで実施できるようにしてリードタイムを短縮するため。

- Decision: `/app/approvals` に `stale_only` フィルタと `oldest/newest` ソートを追加した。
- Why: SLA超過承認の優先処理と、運用時の確認順序（古い順/新しい順）を明示的に切り替えられるようにするため。

- Decision: `sendApprovalReminders`（lib）と `/api/approvals/reminders`（cron API）を追加し、SLA超過pending承認のSlack再通知を自動化した。
- Why: 承認滞留を定期的に押し戻し、手動巡回に依存しない承認促進ループを作るため。

- Decision: 承認リマインドは `approval_id` 単位でクールダウン重複排除し、同一approvalへの短時間連投を防ぐ方式にした。
- Why: 通知ノイズを抑えつつ、未対応承認への再通知だけを確実に送るため。

- Decision: 理想像に「会話起点の実行モデル（shared/personal chat）」を正式追加し、自然言語コマンド -> 実行計画提示 -> Yes確認後実行を標準操作として採用する。
- Why: フォーム/ボタン操作を最小化し、人間がチャットで業務依頼・状況照会・実行承認を行える運用に移行するため。

- Decision: チャットは `shared`（組織共通）と `personal`（個人）を分離し、どちらも最終的に同一の policy/approval/action runner ガードを通す。
- Why: 情報公開範囲の違いを扱いつつ、実行統制と監査証跡は単一の安全基準で維持するため。

### 2026-03-05 - Chat command layer MVP

- Decision: `chat_sessions/chat_messages/chat_intents/chat_confirmations/chat_commands` を追加し、自然言語の依頼を「意図解析 -> 実行確認 -> 実行」の3段階で台帳化する。
- Why: 会話起点の操作を監査可能にし、誤実行を防ぎながら UI 操作依存を減らすため。

- Decision: MVP の意図解析はルールベース（`status_query` と `create_task`）から開始し、`create_task` は必ず Yes/No 確認を要求する。
- Why: まず安全に運用可能な最小機能を実装し、将来のLLMベース意図解析へ段階拡張しやすくするため。

- Decision: チャット経由で作成されたタスクには `TASK_CREATED` イベント payload に `source: chat_command` と確認/コマンドIDを付与する。
- Why: 後から「どの会話承認で起票されたか」を task ledger だけで追跡できるようにするため。

- Decision: チャット実行意図に `request_approval` と `decide_approval`（承認/却下）を追加し、いずれも実行前に確認を必須化した。
- Why: UI遷移なしで承認フローを進めつつ、誤操作を防ぎ監査可能な確認ステップを維持するため。

- Decision: チャット承認判断は `decideApprovalShared` を再利用し、`source=chat` を明示して既存の `HUMAN_APPROVED/HUMAN_REJECTED` と `TASK_UPDATED` ログへ統合した。
- Why: Web/Slack/Chat で承認結果の一貫性を保ち、証跡集計を単純化するため。

- Decision: `status_query` は全体サマリに加え、引用符つきタスク名がある場合は対象タスクの個別ステータス（承認待ち/最新イベント/最新アクション）を返す。
- Why: オペレーターが「〜ってどうなってる？」をチャットだけで即確認できる導線を作るため。

- Decision: 個人チャット秘匿を担保するため、chat系RLSを `org member` 条件のみから `session access` 条件（shared or owner_user_id=auth.uid）へ強化した。
- Why: 同一org内でも personal chat の内容は本人のみ参照可能にし、shared chat と明確にアクセス境界を分離するため。

- Decision: Gmail実行ロジックを `executeTaskDraftActionShared` に共通化し、タスク詳細UI実行とチャット実行で同一のガード（policy/governance/idempotency/concurrency）を使用する。
- Why: 実行経路ごとの差分バグを減らし、安全条件と監査イベントの一貫性を維持するため。

- Decision: チャット意図に `execute_action` を追加し、対象タスクのメール実行を Yes 確認後にのみ実行する。
- Why: 「UI操作なし実行」を前進させつつ、誤実行防止の human confirmation を維持するため。

- Decision: チャットで対象タスク/承認待ちが複数候補になる場合は実行を止め、候補リストを返して `task_id` または完全タイトルの再指定を必須化した。
- Why: 自然言語による曖昧一致で誤タスクに承認・実行するリスクを最小化するため。

- Decision: チャット意図解析で UUID 形式の `task_id` を自動抽出し、タイトル指定より優先して対象解決する。
- Why: オペレーターがIDを貼るだけで確実に対象タスクを指定でき、曖昧一致を避けられるため。

- Decision: `taskHint` 未指定時は同一セッションの直近メッセージ metadata から `task_id` を補完して承認依頼/承認判断/実行の既定対象に使う。
- Why: 会話の連続操作（作成直後に承認依頼、承認直後に実行）で再指定負荷を下げつつ、セッション内コンテキストに限定して安全に補完するため。

- Decision: `/app/chat/*` に `chat_commands` ベースの「コマンド監査ビュー」を追加し、実行ステータス・対象タスクリンク・result_json を画面で確認できるようにした。
- Why: 会話だけでは追いづらい実行結果を可視化し、オペレーターが失敗原因やスキップ理由を即時トリアージできるようにするため。

- Decision: 監査ビューに `execution_status` フィルタ（all/failed/pending/running/done）を追加し、失敗コマンドに限定したトリアージを可能にした。
- Why: チャット運用が増えた時に、失敗案件だけを短時間で処理できるオペレーション導線が必要なため。

- Decision: `failed` な chat command からは「再実行確認を作成」アクションを提供し、元intentを再利用して再実行する（即実行ではなく再確認必須）。
- Why: リトライ可能性を上げつつ、再実行時の誤操作防止と監査性を維持するため。

- Decision: Playwright E2E に chat command の承認依頼/実行フロー（確認ステップ付き）を追加し、`ACTION_EXECUTED` までの回帰を検証する。
- Why: チャット機能はUI操作レス実行の中核であり、既存の手動フロー回帰とは別に継続検証が必要なため。

- Decision: チャット確認実行時に open incident を再評価し、`decide_approval` / `execute_action` はインシデント中に強制ブロックする。
- Why: 画面操作レス実行の入口でも incident mode の停止ルールを明示適用し、緊急時の誤実行を抑止するため。

- Decision: `/app/chat/audit` を追加し、chat_commands を shared/personal 横断（RLS許可範囲）で status/scope/intent フィルタ可能な監査ページとして提供した。
- Why: 会話起点の実行量が増えても、失敗トリアージと実行追跡を単一画面で行えるようにするため。

- Decision: チャット確認作成にガードレールを追加し、同一セッションの pending 確認上限（既定5件）と短時間連続作成クールダウン（既定8秒）を適用した。
- Why: ボット暴走や誤連打で確認キューが埋まる運用事故を防ぎ、オペレーターが処理可能なペースに制御するため。

- Decision: `/app/chat/audit` から failed command の「再実行確認を作成」を直接実行できるようにし、監査画面でトリアージから復旧まで完結可能にした。
- Why: 失敗対応時に shared/personal チャット画面へ戻る手間を減らし、運用復旧のリードタイムを短縮するため。

- Decision: `/app` の優先対応キューに「チャット失敗(7d)」メトリクスを追加し、`/app/chat/audit?status=failed` へ遷移できるようにした。
- Why: 会話起点運用の増加に合わせて、チャット実行失敗をトップ画面から即時検知・対処できるようにするため。

- Decision: `retryChatCommand` に `return_to` を追加し、監査ページ起点の再実行時は `/app/chat/audit` へ結果を戻すようにした。
- Why: トリアージ中の画面遷移を最小化し、失敗対応オペレーションを中断させないため。

- Decision: `/app/chat/audit` で pending/overdue confirmations を可視化し、`期限切れ確認を整理` を実行可能にした。
- Why: 実行確認キューの滞留を監査画面から直接解消できるようにし、確認フローの健全性を維持するため。

- Decision: 期限切れ確認整理ロジックを `lib/chat/maintenance.ts` に共通化し、UI server action と cron API の両方から利用する設計にした。
- Why: 同じ更新ロジックを一元化して挙動差分を防ぎ、運用時の保守を容易にするため。

- Decision: `/api/chat/confirmations/expire` を追加し、org単体/全orgバッチで pending確認の期限切れ処理を実行できるようにした（token guard + retry/circuit対応）。
- Why: 手動整理に依存せず、確認キューを自動で健全化する定期保守ループを確立するため。

- Decision: `/api/chat/audit/export` を追加し、`/app/chat/audit` のフィルタ条件をそのまま CSV/JSON 出力できるようにした。
- Why: チャット起点オペレーションの監査証跡を外部レビュー・保存へ渡しやすくするため。

- Decision: chat監査エクスポートに `CHAT_EXPORT_TOKEN` を導入し、`x-export-token + org_id` で server-to-server 取得を許可するモードを追加した。
- Why: UIセッションなしでも安全に定期取得やバックアップを実行できるようにするため。

- Decision: chat監査エクスポート用にCLI (`export-chat-audit-json.mjs`) を追加し、ページング全件取得・resume・shard出力をサポートした。
- Why: 運用監査ログの定期バックアップと大規模データ取得を、手作業なしで再現可能にするため。

- Decision: governance recommendations にチャット運用シグナル（`failed chat commands(7d)`, `pending/overdue chat confirmations`）を追加し、閾値超過時に `/app/chat/audit` への改善提案を生成する。
- Why: チャット起点オペレーションを例外管理ループへ統合し、失敗・滞留の早期是正を自動促進するため。

- Decision: チャット実行確認（confirmed）にユーザー単位の日次上限 `CHAT_DAILY_EXECUTION_LIMIT`（既定30）を追加し、上限超過時は自動で confirmation を declined にする。
- Why: 会話起点の実行が短時間に集中した際の誤操作・暴走リスクを抑え、安全に運用できるスループットへ制御するため。

- Decision: `/app/chat/shared` と `/app/chat/me` に本日の confirmed 実行数と残量（`x/y`）を表示し、使用率に応じて色分けする。
- Why: 実行上限に達する前にオペレーターが状況を把握し、運用計画を調整できるようにするため。

- Decision: チャットの `status_query` を拡張し、自然文キーワードから `approval / proposal / exception / incident / overview` の焦点を判定して、対象別サマリを返すようにした。
- Why: 「〜ってどうなってる？」の質問に対して画面遷移なしで即時トリアージ情報を返し、会話起点オペレーションの実用性を上げるため。

- Decision: `status_query` の返答には必ず「次アクション」(優先順3件) と運用画面パスを含める形式を採用した。
- Why: 状況説明だけで止まらず、会話から即オペレーションへ遷移できる導線を標準化するため。

- Decision: チャットに `accept_proposal` 意図を追加し、「提案を受け入れて（任意で承認依頼まで）進める」複合コマンドを確認付きで実行できるようにした。
- Why: 提案画面での手動操作を減らし、会話だけで L2 フロー（提案採択→タスク化→承認依頼）を短縮するため。

- Decision: 提案受け入れロジックは `acceptProposalShared` (`lib/proposals/decide.ts`) へ共通化し、UI とチャットで同一のイベント記録/Slack投稿/検証を使う設計にした。
- Why: 分岐実装による監査差分と不整合を防ぎ、将来の API 実行経路追加にも再利用しやすくするため。

- Decision: チャットに `bulk_decide_approvals` 意図を追加し、承認待ちを最大10件まで一括承認/却下できるようにした（既定3件、確認必須）。
- Why: 承認キューの定型処理を短時間で片付け、Human-in-the-loopを「判断」に集中させるため。

- Decision: 一括承認は既存の `decideApprovalShared` を1件ずつ再利用し、`HUMAN_APPROVED/HUMAN_REJECTED` と `TASK_UPDATED` の監査イベント整合性を維持する。
- Why: 新規バッチ専用更新ロジックを作らず、単体承認と同じ統制・証跡を保証するため。

- Decision: 失敗したチャットコマンドに対し、`createRetryConfirmationForFailedCommand` を追加して単体再実行確認作成ロジックを共通化した。
- Why: 単体再実行と一括再実行で同じ検証（failed限定・pending重複防止・確認上限）を使い、挙動差分を防ぐため。

- Decision: `/app/chat/audit` に「再実行確認一括作成」アクションを追加し、scope/件数指定で failed コマンドの確認をまとめて生成できるようにした。
- Why: 例外キュー復旧の初動を高速化し、失敗コマンドの再試行準備を監査画面で完結させるため。

- Decision: チャットに `bulk_retry_failed_commands` 意図を追加し、「失敗コマンドをまとめて再実行確認して」を確認付きで実行可能にした（current/shared/personal/all scope 対応）。
- Why: 監査画面に移動せず会話だけで復旧オペレーションを起動できるようにし、例外処理のレイテンシをさらに下げるため。

- Decision: `status_query` 返答に focus別の「優先対象TOP3（タイトル + 直リンク）」を追加し、承認/提案/例外/インシデントの即時対処対象を本文に埋め込む形式にした。
- Why: サマリ確認後に対象を探す手間をなくし、チャットから最短で該当画面へ遷移して処理できるようにするため。

- Decision: チャットに `quick_top_action` 意図を追加し、状況回答のTOP候補に対して `#1を承認` / `#2を提案受け入れ` / `#1を承認依頼` のようなクイック実行を確認付きで可能にした。
- Why: 状況確認と実行の往復を減らし、同一会話内で「見る→選ぶ→実行」を完結させるため。

- Decision: `status_query` 返答時の system message metadata に `status_top_candidates` を保存し、クイック実行はこの直近候補を参照する設計にした。
- Why: 自然文からID再指定させずに安全に対象を解決し、誤操作を減らすため。

- Decision: クイック実行の監査性を高めるため、`quick_ref`（候補順位・対象種別・候補ID）を `chat_commands.result_json` と `chat_messages.metadata` に保存し、対象タスクには `CHAT_QUICK_ACTION_USED` を追記する。
- Why: 「どの候補を根拠に実行したか」を後から一意に追跡できるようにし、説明責任と再現性を向上させるため。

- Decision: クイック実行の安全策として `status_top_candidates.generated_at` を保存し、`CHAT_STATUS_TOP_TTL_SECONDS`（既定600秒）を超えた候補では実行を拒否して再度 `status_query` を要求する。
- Why: 古いサマリ候補に対する誤承認・誤実行を防ぎ、最新状態に基づく判断を強制するため。

- Decision: クイック実行で対象がすでに状態変更済み（例: pending承認が存在しない / 既に承認待ち）の場合は失敗にせず `skipped` として扱い、`CHAT_QUICK_ACTION_USED` に `skip_reason` を記録する。
- Why: 競合や先行処理による自然な不一致をエラー扱いせず、監査上は「安全に未実行だった」ことを明示するため。

- Decision: `/app/chat/audit` とチャット内コマンド監査ビューに `skip_reason` / `quick_ref` バッジ（`quick #N action`）を追加し、クイック実行のスキップ要因を一覧で判読できるようにした。
- Why: 詳細JSONを開かなくても、失敗と安全スキップを運用者が即時に見分けられるようにするため。
