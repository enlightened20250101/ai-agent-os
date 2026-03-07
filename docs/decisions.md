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

- Decision: `/app/chat/audit` に `skip_reason` 上位集計（直近7日）カードを追加し、スキップ原因の頻出パターンを可視化する。
- Why: 詰まりの根本要因（例: stale候補、先行承認）を早く特定し、運用改善サイクルを回しやすくするため。

- Decision: `skip_reason` の最多原因に対して `/app/chat/audit` 上で「推奨アクション」カードを自動表示し、対応ページへの導線を付与する。
- Why: 原因把握から次手の実行までの判断コストを減らし、運用改善の実行速度を上げるため。

- Decision: `/app` トップの優先対応キューに「チャット skip(7d)」カードを追加し、主因 `skip_reason` と推奨1手（リンク付き）を同時表示する。
- Why: 監査画面に入る前のダッシュボード段階でチャット運用の詰まりを検知し、初動を速めるため。

- Decision: `/app/chat/audit` に `skip_reason` フィルタを追加し、トップのチャットヘルスカードから `skip_reason=<cause>` 付きで直接遷移する導線を実装した。
- Why: 原因別トリアージ画面へ1クリックで到達できるようにし、分析開始までの時間を短縮するため。

- Decision: `/app/chat/audit` の `skip_reason` 集計チップと行バッジをクリック可能にし、その場で同原因フィルタへ切り替えられるUIにした。
- Why: フィルタ操作を最小化し、一覧確認中のドリルダウン速度を上げるため。

- Decision: `/api/chat/audit/export` に `skip_reason` フィルタを適用し、CSVメタヘッダと `content-disposition` ファイル名へフィルタ値（status/scope/intent/skip_reason）を反映した。
- Why: 監査提出時に「どの条件で抽出したファイルか」をファイル単体で追跡可能にするため。

- Decision: `/app/chat/audit` のCSV/JSONエクスポートUIに `filtered export` バッジと条件サマリ表示を追加し、現在の絞り込みが出力対象に反映されることを明示した。
- Why: 誤った条件での監査出力を防ぎ、オペレーターが抽出範囲を視覚的に確認できるようにするため。

- Decision: `/app/chat/audit` のフィルタフォームに「フィルタをリセット」導線を追加し、ワンクリックで初期一覧へ戻せるようにした。
- Why: 絞り込みを重ねた後の復帰操作を簡略化し、運用時の探索スピードを上げるため。

- Decision: `/app/chat/audit` に「条件リンクをコピー」ボタンを追加し、現在のフィルタ条件付きURL（絶対URL）をクリップボードへ共有できるようにした。
- Why: オペレーター間で同一条件の監査ビューを即共有し、調査の再現性を高めるため。

- Decision: `/app/chat/audit` ヘッダ直下に `status/scope/intent/skip_reason` の現在条件バッジを常時表示する。
- Why: 共有リンク経由でも表示条件を瞬時に把握でき、認識齟齬を減らすため。

- Decision: 現在条件バッジをクリック可能にして、対象条件だけ `all` に戻すトグル動作を追加した。
- Why: 調査中の段階的なフィルタ解除を1クリックで行えるようにし、探索効率を高めるため。

- Decision: `/app/chat/audit` フィルタフォーム直下に「この条件で開く」固定リンクを表示し、現在条件のURLを画面上で即利用可能にした。
- Why: 条件共有や再アクセス時に、コピー操作なしでも同一ビューへ遷移できるようにするため。

- Decision: 監査一覧の `quick #N action` バッジをクリック可能にし、`intent=quick_top_action` へ即絞り込みできる導線を追加した。
- Why: クイック実行由来の履歴だけを迅速に抽出し、クイック操作の品質監査を効率化するため。

- Decision: `skip_reason` 推奨アクションカードのリンク先を監査画面内導線に統一し、現在の `status/scope/intent` を保持したまま `skip_reason=<top>` へ遷移する。
- Why: フィルタ文脈を保ったまま原因深掘りできるようにし、分析の連続性を高めるため。

- Decision: `/app/chat/audit` のフィルタフォーム直下に `表示件数 (filtered/total)` を表示する。
- Why: 絞り込み条件の効き具合を即時に把握し、追加フィルタの要否を判断しやすくするため。

- Decision: 件数サマリに `直近7日 (filtered/total)` を追加し、全期間件数と期間内件数を同時比較できるようにした。
- Why: 一時的なスパイクと長期蓄積を切り分け、優先対応判断をしやすくするため。

- Decision: 件数サマリに `直近7日 filtered比率(%)` を追加した。
- Why: 絞り込み条件が直近運用に対してどれだけ支配的かを即座に判断できるようにするため。

- Decision: `直近7日 filtered比率` は閾値（50%/80%）で色分けし、高比率時は警戒色で表示する。
- Why: 異常傾向の視認性を高め、優先調査対象を即判定できるようにするため。

- Decision: 件数サマリの比率バッジをクリックすると `status=failed` に絞り込む導線を追加し、現在の他フィルタ文脈は維持する。
- Why: 異常比率を見つけた直後に失敗コマンド一覧へ遷移できるようにし、初動を短縮するため。

- Decision: `status=failed` フィルタ時は監査ヘッダに「高優先トリアージ中」バッジを表示する。
- Why: 現在の運用モード（通常監査か失敗対応か）を明示し、判断の優先度を揃えるため。

- Decision: `status=failed` 時は「失敗コマンド再実行確認の一括作成」件数の初期値を 10（通常は5）にする。
- Why: 高優先トリアージモードでの復旧初動を短縮するため。

- Decision: `status=failed` かつ failed件数が閾値以上（5件）では、一括再実行確認ボタンを強調色（赤）+ 優先文言に切り替える。
- Why: 失敗集中時にオペレーターの次アクションを明確化し、復旧の着手遅れを防ぐため。

- Decision: ワークフロー安定化として `WORKFLOW_STEP_TIMEOUT_SECONDS`（既定900秒）を導入し、`tickWorkflowRuns` で running step の経過時間超過を検知したら自動で step/run を failed 化して `WORKFLOW_FAILED` を記録する。
- Why: ハングした実行を放置せず自動的に例外化し、再試行・人手介入へ早く繋げるため。

- Decision: `failRunningStepAndRun` のDB更新にエラーチェックを追加し、失敗更新の取りこぼしを防止した。
- Why: 失敗処理自体の失敗を明示化し、状態不整合を減らすため。

- Decision: `retryFailedWorkflowRun` に `WORKFLOW_STEP_MAX_RETRIES`（既定3）を導入し、stepごとの再試行回数上限を超えた場合は再試行を拒否する。
- Why: 無限リトライによるジョブ占有と障害長期化を防ぎ、原因調査へ確実にエスカレーションするため。

- Decision: 再試行上限到達時は `WORKFLOW_FAILED` に `retry_exhausted=true`, `retry_count`, `max_retries` を含めて記録する。
- Why: 「通常失敗」と「再試行枯渇」を監査上で区別し、復旧方針（再実行ではなく原因修正）を明確化するため。

- Decision: `/app/workflows/runs` に `status` クエリフィルタ（`running|failed|completed|all`）と件数カードを追加し、実行状態別に即時絞り込みできるようにした。
- Why: ワークフロー運用時に「いま対応すべき失敗」「進行中実行」を1画面で判別し、トリアージ速度を上げるため。

- Decision: `/app/workflows/runs` に `retry exhausted runs` 指標を追加し、`workflow_steps.status=failed` かつ `retry_count >= WORKFLOW_STEP_MAX_RETRIES` の run 数を可視化した。
- Why: 再試行不能状態の滞留件数を明示し、単純再実行ではなく設計/データ起因の恒久対応へ優先的に回すため。

- Decision: 共有/個人チャットの意図解析に `run_planner` を追加し、「プランナー実行して」系の依頼を確認付きコマンドとして実行可能にした（`runPlanner` を再利用）。
- Why: UIを開かずに自律提案ループを起動できる運用導線を増やし、目標の会話起点OSに近づけるため。

- Decision: `run_planner` は他の実行系intent同様に確認必須・監査対象（`chat_commands`）として扱い、実行後は `/app/planner` と `/app/proposals` を再検証する。
- Why: 安全性（誤起動防止）と監査性（誰がいつ起動したか）を維持したまま自律機能を開放するため。

- Decision: チャット意図に `run_workflow` を追加し、「ワークフロー実行して」要求を確認付きで `startWorkflowRun` に接続した。
- Why: ユーザーがタスク詳細画面へ遷移せずに実行オーケストレーションを起動できるようにし、会話起点運用を前進させるため。

- Decision: `run_workflow` は対象タスクの `workflow_template_id` を必須とし、未設定時は実行せず明確な修正導線（`/app/tasks` で設定）を返す。
- Why: 誤起動・不完全起動を防ぎ、失敗時もオペレーターが次に取るべき行動を即判断できるようにするため。

- Decision: チャット意図に `bulk_retry_failed_workflows` を追加し、「失敗ワークフローをまとめて再試行」要求を確認付きで実行できるようにした（最大件数はメッセージから解釈、既定3）。
- Why: 例外復旧の初動をチャットから完結させ、障害時のオペレーター負荷を下げるため。

- Decision: 再試行実行は `/app/operations/exceptions` と同じ `retryFailedWorkflowRun` を再利用し、成功/失敗件数と対象run IDsを `chat_commands.result_json` に残す。
- Why: 実装の一貫性を保ちつつ、復旧実行の監査性を強化するため。

- Decision: チャットの曖昧一致エラー（複数タスク/複数提案/複数承認待ち）時に、候補一覧だけでなく「そのまま再送できる具体コマンド例」を返すようにした。
- Why: 再入力の試行錯誤を減らし、チャットコマンドの失敗率を下げるため。

- Decision: `unknown` 意図のシステム返答を具体例付きのガイドに変更し、主要操作（作成/承認依頼/承認/実行/プランナー/失敗workflow再試行）を明示した。
- Why: 初回利用者でも正しい文型へ即到達できるようにし、会話起点オペレーションの学習コストを下げるため。

- Decision: `/app/chat/audit` に「intent別失敗率（現在フィルタ）」を追加し、`failed/total` と失敗率(%)を意図ごとに表示して failed ドリルダウンへ直リンクした。
- Why: どの意図が運用ボトルネックかを即判別し、改善対象を優先順位付きで絞るため。

- Decision: 失敗率が高い意図（件数>=3かつ失敗率>=50%）を `worstIntent` として推奨アクションを表示する。
- Why: 監査画面を「可視化だけ」で終わらせず、次に取るべき改善行動へ繋げるため。

- Decision: `bulkRetryFailedCommands` に `intent_type` フィルタを追加し、失敗コマンドの一括再実行確認作成を意図別に絞り込めるようにした。
- Why: 高失敗intentに対する集中的な復旧オペレーションを1操作で実行できるようにするため。

- Decision: `/app/chat/audit` の一括作成フォームに intent セレクトを追加し、既定値を現在フィルタintent（なければ worstIntent）にする。
- Why: 監査で見つけた失敗クラスターに即追従できるUIにして、復旧までのクリック数を減らすため。

- Decision: `TOP(/app)` で `chat_commands(7d)` と `chat_intents(7d)` を突合し、intent別失敗率から `高失敗intent` を算出して優先対応キューに表示する。
- Why: 監査画面を開く前にホームで異常傾向を検知し、対応開始までの時間を短縮するため。

- Decision: 高失敗intentが閾値（失敗率50%以上）を超える場合、トップページに警告バナーを表示し `status=failed&intent=<type>` の監査ビューへ直接誘導する。
- Why: ボトルネック意図へのトリアージを1クリック化し、会話起点運用の復旧速度を高めるため。

- Decision: `TOP(/app)` の高失敗intentバナーに「このintentで再実行確認を一括作成（5件）」ボタンを追加し、`bulkRetryFailedCommands` を直接実行できるようにした。
- Why: 異常検知から復旧アクションまでを同一画面で完結させ、初動時間をさらに短縮するため。

- Decision: `bulkRetryFailedCommands` 実行時に `/app` も再検証対象に追加した。
- Why: ホーム画面起点の操作後に指標とバナー状態が即時反映されるようにするため。

- Decision: `TOP(/app)` の優先対応キューに `Next Actions (auto-sorted)` を追加し、incident/failed action/stale approval/policy block/high-failure intent/job failure を重み付きスコアで並べ替えて上位5件を表示する。
- Why: オペレーターが毎回どこから着手するか判断するコストを減らし、復旧初動の一貫性を高めるため。

- Decision: `TOP(/app)` の `Next Actions` 各行にクイック実行ボタンを追加し、`失敗workflow再試行(上位3件)` と `期限切れ確認整理` をホームから直接実行可能にした。
- Why: 異常検知後にページ遷移を挟まず一次復旧を開始できるようにし、オペレーションの初動速度を上げるため。

- Decision: `TOP(/app)` が `ok/error` クエリを受け取り、クイック実行の結果をページ内で可視化するようにした。
- Why: ホームからの即時オペレーション後に結果確認のため別画面へ行く必要を減らし、運用ループを短くするため。

- Decision: `retryTopFailedWorkflowRuns` の結果文字列（`success=, failed=`）と `期限切れ確認更新件数` をパースし、成功/失敗件数チップを表示する。
- Why: 成否メッセージを定量で読み取りやすくし、次のアクション判断を速くするため。

- Decision: `TOP(/app)` のクイック実行ボタン（失敗workflow再試行・期限切れ確認整理・高失敗intent再実行確認）にブラウザ確認ダイアログを必須化した。
- Why: ホーム画面からの即時オペレーションで誤クリックによる大量実行を防ぎ、安全なデフォルトを維持するため。

- Decision: `ConfirmSubmitButton` を `useFormStatus` 対応に拡張し、送信中は `disabled + 実行中ラベル` へ切り替えるようにした。
- Why: トップ画面のクイック実行で二重送信を防ぎ、意図しない重複オペレーションを抑止するため。

- Decision: `/app/chat/audit` の実行ボタン（期限切れ整理・一括再実行確認作成・行単位再実行確認作成）を `ConfirmSubmitButton` に統一し、確認ダイアログ + 送信中disabledを適用した。
- Why: 監査画面は一括操作が多いため、誤実行と二重送信を防いで安全な運用を維持するため。

- Decision: `/app/operations/exceptions` の高リスク操作（Slack通知、一括/単体 workflow再試行、選択ケース一括更新）を `ConfirmSubmitButton` に統一し、確認ダイアログと送信中disabledを適用した。
- Why: 例外トリアージ画面での誤操作・二重実行を防ぎ、復旧オペレーションの安全性を高めるため。

- Decision: `/app/approvals` の判断・再通知操作と `/app/tasks/[id]` の主要実行操作（ドラフト生成、承認待ち化、承認依頼、メール実行、workflow開始）を `ConfirmSubmitButton` に統一した。
- Why: 承認/実行フロー全体で確認ダイアログと二重送信防止を標準化し、誤操作リスクを下げるため。

- Decision: 実行結果表示を統一するため `StatusNotice` 共通コンポーネントを追加し、`/app/tasks/[id]` と `/app/approvals` の `ok/error` 表示に適用した。
- Why: 画面ごとの表示ゆれを減らし、実行後フィードバックの視認性を一貫化するため。

- Decision: `tasks/[id]` の主要 server actions（承認待ち化・承認依頼・ドラフト生成・メール実行）と `approvals/decideApproval` は成功時に `?ok=` を付けて同画面へリダイレクトする。
- Why: 実行後に「何が成功したか」を明示して、操作完了の認知を早めるため。

- Decision: `StatusNotice` の適用範囲を `/app/workflows`, `/app/workflows/runs`, `/app/workflows/runs/[id]`, `/app/operations/jobs`, `/app/operations/exceptions` に拡張した。
- Why: 運用系画面の実行結果表示を同一UIに統一し、画面横断での認知負荷を下げるため。

- Decision: `/app/operations/jobs` の手動実行ボタン（インシデント判定、workflow tick、ops alert再送）と `/app/workflows/runs/[id]` の進行/再試行ボタンを `ConfirmSubmitButton` 化した。
- Why: 本番運用への影響が大きい手動オペレーションに確認ダイアログと二重送信防止を適用するため。

- Decision: `/app/agents` と `/app/tasks` の作成/状態変更操作を `ConfirmSubmitButton` に統一し、確認ダイアログと送信中disabledを適用した。
- Why: 基本CRUD操作でも誤操作や二重送信を防ぎ、全画面で同じ安全操作体験を提供するため。

- Decision: `agents/actions` と `tasks/actions` は成功時に `?ok=` を付けて同画面に戻すようにした。
- Why: 作成/更新直後に明示的な成功フィードバックを返し、操作完了の認知を高めるため。

- Decision: `/app/workflows` のテンプレート作成を `ConfirmSubmitButton` 化し、確認ダイアログと送信中disabledを適用した。
- Why: 主要作成操作の安全性を他画面と統一し、誤作成と二重送信を防ぐため。

- Decision: `createWorkflowTemplate` は成功時に `?ok=` 付きで `/app/workflows` へリダイレクトする。
- Why: 作成直後の成功フィードバックを明示し、操作完了を即時に伝えるため。

- Decision: `governance` 系の主要更新画面（`autonomy`, `budgets`, `incidents`, `recommendations`）に `ConfirmSubmitButton` と `StatusNotice` を適用し、結果表示と安全操作を統一した。
- Why: 設定変更・インシデント操作・改善アクション適用は影響範囲が大きいため、確認と二重送信防止を標準化するため。

- Decision: `/app/integrations/slack` の保存・テスト送信操作を `ConfirmSubmitButton` 化し、`StatusNotice` に統一した。
- Why: 外部通知への実送信操作は誤操作コストが高いため、確認付き実行を既定化するため。

- Decision: `/app/integrations/google` に `StatusNotice` を適用し、OAuth callback の `ok/error(+description,+error_id)` を統一表示する。
- Why: 接続失敗時の原因表示を既存ページと同一パターンに揃え、運用時の読み取りを簡潔にするため。

- Decision: `/app/integrations/google` の切断操作を `ConfirmSubmitButton` 化した。`/app/governance/trust` は読み取り/GETフィルタ中心のため確認ダイアログ対象外とした。
- Why: 破壊的操作のみ確認必須にして、読み取り画面の操作負荷は増やさないため。

- Decision: E2E（`agents -> tasks -> approvals flow`）で提案受け入れボタンのロケータを `exact: true` に固定し、`受け入れ` と `受け入れ+承認依頼` の曖昧一致を排除した。
- Why: Playwright strict mode 競合での不安定失敗を防ぎ、提案受け入れ経路の再現性を上げるため。

- Decision: Slack intake のタスク可視化チェックは短時間の遅延に弱いため、E2Eでは再読込リトライ後も未反映なら警告ログを出して core flow 検証を継続する。
- Why: 非同期取り込みの一時的遅延で主目的（作成→承認→実行→証跡）まで失敗させないようにし、CIフレーク率を抑えるため。

- Decision: E2Eで`confirm`ダイアログ自動承認ヘルパーを導入し、確認文言（`実行しますか`）が実際に出ることを検証した。
- Why: `ConfirmSubmitButton` 標準化の回帰検知を自動化し、UI安全ガードが外れた場合に早期検出できるようにするため。

- Decision: Gmail送信MIMEの本文エンコードを `Content-Transfer-Encoding: base64` から `8bit` に変更し、UTF-8本文をそのままRFC822メッセージへ載せる方式に統一した。
- Why: 日本語メールでの文字化けリスクを下げるため、二重エンコード解釈に依存しないシンプルなUTF-8送信を採用する。

- Decision: Unified Business Ledgerの最小実装として `business_cases` を追加し、`tasks.case_id` で案件とタスクを紐付ける構成にした（`/app/cases` + `/app/tasks` で運用）。
- Why: 「タスク単位」だけでなく「案件単位（Case）」で状態と例外を追跡できる土台を先に作り、将来の文書/照合/支払ワークフロー統合へ接続しやすくするため。

- Decision: `business_cases` / `tasks.case_id` が未適用の環境でも既存フローを壊さないよう、UIとserver actionに missing table/column フォールバックを実装した。
- Why: migration適用タイミング差で開発・検証環境が一時不一致でも、既存のタスク運用を継続可能にするため。

- Decision: `chat_*` テーブル未適用環境で `/app/chat/shared|me|audit` が 500 にならないよう、missing-schema検知 (`isMissingChatSchemaError`) とフォールバックUIを実装した。
- Why: 現場の migration 適用遅延時でも画面が即死せず、原因と対処（`supabase db push`）を明示して運用停止を避けるため。

- Decision: チャット画面は「上=会話履歴、下=入力フォーム」の会話中心レイアウトへ再構成し、モバイルでもLINE/ChatGPTに近い導線にした。
- Why: 入力欄が常に画面下にある構造の方が会話体験として自然で、運用オペレーション中の入力コストが下がるため。

- Decision: `app_locale` Cookie + `/app/settings` を追加し、MVPとして日本語/英語のUI切替を導入した（まずはナビとチャット画面から適用）。
- Why: 英語表記の混在を段階的に解消しつつ、グローバル運用にも拡張できる最小構成を先に作るため。

- Decision: チャット意図のタスク検索は、task_hintがUUIDでない場合に `id.eq` を使わず `title ilike` のみで検索するよう修正した。
- Why: タスク名をUUID列へ比較して発生していた `invalid input syntax for type uuid` エラーを解消し、自然文指示の成功率を上げるため。

- Decision: Unified Business Ledgerを強化するため `case_events` 台帳を追加し、`CASE_CREATED / CASE_STATUS_UPDATED / CASE_TASK_LINKED / CASE_TASK_STATUS_SYNC / CASE_APPROVAL_DECIDED` を記録する。
- Why: タスク単位イベントだけでは追いづらい「案件単位の責務・履歴」を分離して、監査と例外トリアージをCase起点で実施しやすくするため。

- Decision: Caseイベント記録は業務処理を止めない方針とし、`case_events` 未適用時は安全にno-op（警告ログ）で継続する。
- Why: migration適用の時差で本線の承認/実行フローが停止しないよう、台帳拡張を後方互換で導入するため。

- Decision: Evidence Pack (`/app/tasks/[id]/evidence`) に Case Ledger セクション（`tasks.case_id` の案件情報 + `case_events` 一覧）を追加した。
- Why: タスク単体証跡に加えて、案件単位の経緯（リンク/承認判断/状態同期）を同じ監査レポートで追跡できるようにするため。

- Decision: `/app/cases/[id]` を追加し、案件単位で `case_events`・紐づくタスク・承認/実行履歴を横断確認できる詳細画面を実装した。
- Why: 例外対応や月次締めの運用では、タスク単位より案件単位での俯瞰が必要なため、Case中心のオペレーション画面を先に整備する。

- Decision: `/app` ダッシュボードに `business_cases` ベースの「滞留案件（open かつ一定時間更新なし）」指標を追加し、優先対応キューにも組み込んだ（`CASE_STALE_HOURS`, default 48h）。
- Why: 承認滞留だけでなく案件滞留も同一画面で検知し、Case起点の詰まりを早期にトリアージできるようにするため。

- Decision: `/app/cases/[id]` に「優先トリアージ」セクションを追加し、案件内の承認待ちタスク/失敗アクションを上位表示したうえで `/app/approvals` と `/app/operations/exceptions` へ即遷移できる導線を置いた。
- Why: 案件単位で詰まりを見つけた直後に是正操作へ移れるようにして、例外対応の往復コストを下げるため。

- Decision: `/app/cases` 一覧は `blocked` と長時間未更新 `open` を優先表示する並びに変更し、`緊急`/`滞留` バッジと滞留アラートを追加した（`CASE_STALE_HOURS`, default 48h）。
- Why: 運用者が案件一覧を開いた瞬間に「先に処理すべき案件」を判断できるようにし、ケース滞留の見落としを減らすため。

- Decision: Planner signal に `stale_open_cases`（`business_cases.status=open` かつ長時間未更新）を追加し、提案生成時の優先度計算に反映した。
- Why: タスク滞留だけでなく案件滞留を自律提案の入力に含め、Case起点で未解消案件を前倒し処理できるようにするため。

- Decision: Planner提案は `stale_open_cases` 検知時に専用シード提案（滞留案件の情報回収メール案）を優先生成し、OpenAI生成案と重複除去してマージする方式にした。
- Why: LLM出力の揺らぎに依存せず、ケース滞留に対する最小有効アクションを常に提案できるようにして運用品質を安定化するため。

- Decision: `/app/proposals` で `planner_seed_case_stale` と高優先度/`policy=warn` をバッジと色で強調表示し、滞留案件由来提案の判断導線を短縮した。
- Why: 提案一覧の情報密度が高くなってきたため、優先提案を即判別できる視覚的キューを先に整備するため。

- Decision: 優先提案（滞留案件由来/高優先度/warn）には `最短実行: 受け入れ+承認依頼` の1クリックボタンを追加し、通常の受け入れフォームとは並列で提供する。
- Why: 提案確認後に即座に承認フローへ接続できるようにし、オペレーターの判断から実行準備完了までのステップ数を削減するため。

- Decision: `/app/approvals` に「選択承認のSlack一括再通知」を追加し、既存の単体再通知ロジックを共通化して再利用した。
- Why: 承認滞留が複数件同時に発生した際の手作業クリックを減らし、短時間で再通知を回せる運用導線を確保するため。

- Decision: `/app/approvals` に「リマインド実績（7日）」セクションを追加し、`SLACK_APPROVAL_POSTED`（`payload.reminder=true`）イベントから送信総数/手動・自動内訳/履歴を可視化した。
- Why: 再通知施策の実行量と運用効果をその場で確認できるようにして、承認滞留の改善ループを回しやすくするため。

- Decision: `/api/approvals/reminders/auto` を追加し、`stale pending approvals >= threshold` のときだけ再通知ジョブを実行するガードを導入した（`APPROVAL_REMINDER_AUTO_MIN_STALE`, default 3）。
- Why: 常時再通知によるノイズを抑えつつ、滞留が一定量を超えた場合のみ自動介入して運用負荷を下げるため。

- Decision: auto再通知APIは `APPROVAL_REMINDER_AUTO_RUN` / `APPROVAL_REMINDER_AUTO_SKIPPED` を `task_events` に記録し、`/app/approvals` で threshold・current stale・直近結果（skipped/sent）を可視化する。
- Why: 自動化ガードが「いつ・なぜ実行/スキップされたか」を画面上で追えるようにして、運用者の信頼性とデバッグ性を高めるため。

- Decision: `/app/approvals` の Auto Guard セクションに「今回のみ閾値指定で実行」フォームを追加し、`min_stale` を一時上書きして手動実行できるようにした。
- Why: 緊急時にenv変更やcron待ちをせず、画面上の操作だけでガード条件を調整して即時に再通知を走らせるため。

- Decision: Auto Guard セクションに「推奨閾値（現在の stale pending 件数から算出）」とワンクリック実行を追加し、手動実行フォームの初期値も推奨値にした。
- Why: 運用者が閾値を都度考える負荷を減らし、状況に応じたガード実行をより短い操作で行えるようにするため。

- Decision: Auto Guard の直近結果カードに「前回比(stale件数)」を追加し、直近2回の auto 実行ログから改善/悪化/横ばいを表示する。
- Why: 再通知施策の効果を単発値ではなくトレンドで判断できるようにし、次アクションの優先度を決めやすくするため。

- Decision: Auto Guard カードにトレンド連動の推奨アクション文言を追加し、悪化時はより低い閾値での緊急実行ボタンを追加した。
- Why: オペレーターが数値解釈を行わずに次の対応を即決できるようにし、悪化時の初動を短縮するため。

- Decision: `/app` トップにも Auto Guard 状態カード（stale/threshold、run/skipped、delta）と「推奨値で実行」ボタンを追加し、承認ページへ遷移せずに一次対応可能にした。
- Why: ホーム画面を運用コックピットとして強化し、承認滞留への初動時間をさらに短縮するため。

- Decision: `/app` トップの Auto Guard カードでも、delta悪化時に低閾値の「悪化対応」実行ボタンを表示するようにして、承認ページと同等の緊急導線を揃えた。
- Why: ダッシュボード起点の運用でも悪化シグナルに即応できるようにし、ページ遷移による対応遅延を減らすため。

- Decision: `/app` の優先対応キューにも Auto Guard の短文サマリ（`reason` と `delta`）を表示し、滞留承認カードと Next Actions の両方で即読できるようにした。
- Why: 詳細カードを開かずに現在の自動再通知状態を把握できるようにして、キュー上での優先度判断を速くするため。

- Decision: `/app` 優先対応キューの Auto Guard サマリは `delta` に応じて色分け（悪化=rose, 改善=emerald, 横ばい=amber）するようにした。
- Why: 数値を読まなくても状態の方向性を瞬時に判別できるようにして、運用判断の速度を上げるため。

- Decision: `/app` の滞留承認カードは `delta>0`（悪化）時に `悪化中` バッジを pulse 表示する。
- Why: 優先対応キュー内で悪化シグナルに視線を集め、初動対応の見落としを減らすため。

- Decision: `/app` の Auto Guard カードは悪化時に「推奨実行」ボタンを主ボタンスタイル（rose塗り）へ切り替え、ラベルも `優先実行` に変更する。
- Why: 悪化局面で最初に押すべきアクションを視覚的に明示し、対応着手までの判断時間を短縮するため。

- Decision: 悪化時の Auto Guard 主ボタンはカード上段へ配置し、通常時の推奨ボタンは従来位置に残す出し分けにした。
- Why: 悪化シグナル時に最優先アクションを視線の最初に置いて、クリックまでの迷いを最小化するため。

- Decision: `/app/operations/jobs` にも Guard再通知の手動実行を追加し、`APPROVAL_REMINDER_AUTO_RUN/SKIPPED` をジョブ画面で集計表示するようにした。
- Why: 承認ページだけでなく運用ジョブ画面からも同じ自動化制御を行えるようにして、NOC的運用の導線を一本化するため。

- Decision: `/app/operations/jobs` に「承認Auto Guard推移（7日）」縦棒を追加し、`auto_run` / `auto_skipped` を同一グラフで比較表示する。
- Why: Auto Guardが実際に送信を実行しているか、閾値スキップが多いかを運用ジョブ画面で即判断できるようにするため。

- Decision: Auto Guard推移セクションに、`stale件数` と `run/skipped` バランスに応じた推奨アクション文を追加した。
- Why: 指標を見てから次に何をするかの判断を短縮し、運用者の意思決定をワンステップ化するため。

- Decision: Auto Guard推移セクションは推奨文に加えて、条件に応じた即実行ボタン（通常閾値 or 低閾値）を表示するようにした。
- Why: 推奨の読解で止まらず、その場で実行まで完結できるようにして対応速度を最大化するため。

- Decision: `/app/operations/jobs` の Auto Guard推移に、guard実行結果（success/skipped/error）を色付きバナーで表示するようにした。
- Why: 実行直後の状態を同じセクション内で即確認できるようにし、次の判断（再実行/閾値調整）を速めるため。

- Decision: Chat intent に `update_case_status` を追加し、`案件「...」を blocked/closed/open に変更` の自然文を確認付きで実行できるようにした。
- Why: ケース中心運用の更新操作をUI遷移なしで完結させ、チャット起点オペレーションの実用性を上げるため。

- Decision: `business_cases` に `owner_user_id` と `due_at` を追加し、案件の担当者・期限をCase Ledgerで一元管理する最小運用モデルに拡張した。
- Why: 案件ベースの滞留解消を進めるには、状態(open/blocked/closed)だけでなく「誰が対応するか」「いつまでに対応するか」を同じ台帳で扱う必要があるため。

- Decision: `/app/cases/[id]` に担当者更新フォームと期限更新フォームを追加し、更新時に `CASE_OWNER_UPDATED` / `CASE_DUE_UPDATED` を `case_events` へ記録する。
- Why: ケース運用の変更履歴を監査可能に保ちながら、詳細画面から即時にオペレーションできるようにするため。

- Decision: Chat intent を `update_case_owner_self` / `update_case_due` まで拡張し、`案件「...」を自分に割り当て` と `案件「...」の期限をYYYY-MM-DDにして` を確認付きで実行可能にした。
- Why: ケース運用の主要操作（状態・担当・期限）をチャットで完結できるようにし、UI遷移なしでの実行率を高めるため。

- Decision: チャット実行トリガーを `@AI` 明示方式に変更し、`@AI` を含まない投稿は通常メッセージ（メンバー間会話/メモ）として保存のみ行う。
- Why: 会話チャネルをそのまま共同作業に使えるようにしつつ、AIの自動実行を意図的な呼び出しに限定して安全性と予測可能性を高めるため。

- Decision: 共有/個人チャットUIにワークスペース名・メンバー数・`@AI` ルールを常時表示し、`@mention` を可視化ハイライトする。
- Why: 同一ワークスペース内の共有境界を明確にし、どの発言がAI実行対象かを画面上で即判別できるようにするため。

- Decision: Appヘッダーに `Workspace(name)` と `org_id` を表示し、現在所属コンテキストを全ページで確認可能にした。
- Why: 複数アカウント運用時に「どの組織データを見ているか」を常に明示し、誤操作リスクを下げるため。

- Decision: チャットを `shared/personal` から `shared/personal/channel` の3スコープへ拡張し、`chat_channels` + `chat_channel_members` でSlack風チャンネル運用（作成/招待/退出）を導入した。
- Why: ワークスペース内の複数チーム会話を分離しつつ、どのチャンネルでも `@AI` 呼び出しを可能にするため。

- Decision: `ai_execution_logs` を追加し、チャット経由のAI実行結果（done/failed/declined）を org 横断で記録・閲覧できる `/app/executions` を実装した。
- Why: チャンネル閲覧権限に依存せず、団体単位で実行監査を行えるようにするため。

- Decision: メンションサジェストUI（`@...`）を導入し、`@AI` 以外のメンションは会話/メモ用途として保持、`@AI` を含む発言のみ意図解析・実行確認フローへ進める方式を継続した。
- Why: Slack同様の共同会話体験を維持しながら、AI実行を明示呼び出しに限定して誤実行を防ぐため。

- Decision: `user_profiles`（display_name, avatar_emoji）を追加し、設定画面で更新可能にしてチャットバブルに表示名/アイコンを表示する。
- Why: 複数アカウント運用時の識別性を高め、チーム会話の可読性を上げるため。

- Decision: `user_profiles.avatar_url` を追加し、設定画面で画像URLまたは画像ファイル（256KB以下）を保存できるようにした。
- Why: チーム会話時の人物識別性を上げ、Slackライクな視認性を確保するため。

- Decision: 取引先情報の最小台帳として `vendors` を追加し、`/app/partners` で作成・状態更新（active/inactive）・メモ編集を可能にした。
- Why: バックオフィス実務で必要な取引先データの保管/更新導線を先に確保するため。

- Decision: 社外連絡先テーブル `external_contacts` を追加し、チャンネルで `dm_external` を作成できるようにした。
- Why: 社外関係者との会話文脈をワークスペース内で追跡し、将来の外部送信連携の母体にするため。

- Decision: チャットチャンネルを `channel_type(group/dm_internal/dm_external)` に拡張し、`/app/chat/channels` でグループ・DM（社内/社外）を作成できるようにした。
- Why: 会話コンテキストを用途別に分離し、共有/個人チャットだけでは不足する実務コミュニケーション構造を補うため。

- Decision: `ai_execution_logs` を org横断監査台帳として運用し、チャットの confirmed 実行を `done/failed/declined` で記録する方式を採用した。
- Why: チャンネル閲覧権限とは独立して、組織全体のAI実行責任トレースを一元化するため。

- Decision: 設定画面のプロフィール入力を簡素化し、`表示名 + 画像アップロード` のみに統一した（絵文字アイコン/画像URL入力は廃止）。
- Why: 運用上の入力負荷と混乱を減らし、要望どおり画像ベースのプロフィールに集中するため。

- Decision: メンション解決の安定化のため `user_profiles.mention_handle` を追加し、メッセージ保存時に `mentions_user_ids` を metadata へ記録するようにした。
- Why: 表示名変更があっても実体ユーザーIDを追跡できる監査性を確保するため。

- Decision: `dm_external` チャンネルに Gmail 実送信アクション（件名/本文）を追加し、送信結果を `ai_execution_logs` に `source=external_dm` で記録する。
- Why: 社外DM運用を会話ログだけで終わらせず、実際の外部送信まで接続して監査可能にするため。

- Decision: `/app/executions` に集計カード（total/done/failed/success rate）と CSV エクスポート導線 (`/api/executions/export`) を追加した。
- Why: 実行監査を一覧確認だけでなく、定量把握と二次分析に使える形へ拡張するため。

- Decision: チャット経由の実行系E2Eシナリオは `@AI` 明示メンション必須に統一し、確認待ちUI (`実行確認待ち`) を `@AI` 投稿時のみ期待するようにした。
- Why: 現行仕様（`@AI` 付きのみAI実行）とテストを一致させ、誤検知を防ぐため。

- Decision: `/app/tasks/[id]` の `executeDraftAction` で `redirect()` を try ブロック内で直接呼ばない形に変更し、`NEXT_REDIRECT` がURLの `error` 表示に漏れる不具合を防止した。
- Why: 既存の成功/スキップ導線を維持しつつ、ユーザーに内部例外名が見える不自然な挙動をなくすため。

- Decision: `/app/chat/channels` は作成フォームを常時大表示せず、ヘッダー内のコンパクトな「+ 新規チャンネル」導線へ変更し、DMはメンバープロフィール一覧から直接作成するUIに統一した。
- Why: Slackライクな導線に寄せ、チャンネル作成を主画面のノイズにせず、DM開始を「相手から始める」直感的な操作へ寄せるため。

- Decision: チャンネル画面上では `社内/社外` のDM種別選択を廃止し、ユーザー向け文言は単に `DM` として扱う（外部連絡先向け特殊導線は既存機能として内部的に保持）。
- Why: 日常利用での概念を単純化し、目的（誰と話すか）に集中できるUXを優先するため。

- Decision: DM作成時は同一ユーザー組み合わせの既存 `dm_internal` チャンネルを先に検索し、存在する場合は新規作成せず既存DMへ遷移する。
- Why: 1対1会話の重複チャンネル発生を防ぎ、Slackライクな「相手ごとに1DM」体験に寄せるため。

- Decision: チャンネル一覧とDM候補一覧では raw user_id を表示せず、表示名ベースで表示する（未設定時は汎用ラベル）。
- Why: ID表示は利用者価値が低く視認性を下げるため、実運用で意味のある名前中心のUIにするため。

- Decision: 画面上の識別子表示ポリシーを「ID直表示しない」に統一し、`org_id / user_id / task_id / approval_id / proposal_id / run_id` などの表示は名称・状態・時刻中心へ置換した。
- Why: 利用者にとってID文字列の意味は薄く可読性を下げるため。運用上必要な識別は内部キー/リンクで保持し、UIは意思決定に必要な情報だけを見せるため。

- Decision: E2Eで必要な組織識別は画面文言ではなく非表示の `data-testid=\"org-context-id\"` から取得する方式へ変更した。
- Why: ID非表示UX方針を保ちながら、テストの安定性を維持するため。

- Decision: サインアップ時に `ワークスペース名` を入力できるようにし、signup 完了後は `/app/onboarding` へ値を引き継いで初期組織作成時の `orgs.name` に反映する。
- Why: 初回体験で組織名を明示的に決められるようにし、後からの名称変更コストを下げるため。

- Decision: `org_invite_links` テーブルを追加し、設定画面から同一ワークスペース向けの招待リンクを発行できるようにした。招待リンクは有効期限・利用回数を持ち、オンボーディング時に消費して membership を作成する。
- Why: 「同じ所属への招待」を安全に実現し、メール招待未実装でもURL共有で最小導線を提供するため。

- Decision: 監査/詳細UIに表示する JSON は `toRedactedJson` で ID・トークン類をマスクした表示へ統一した（内部保存データは変更しない）。
- Why: 監査性を維持しつつ、UI上での識別子・秘密値の露出を減らし、可読性と安全性を両立するため。

- Decision: 招待リンク参加フローは「未ログインなら `/signup?invite=...`、ログイン済みなら `/app/onboarding?invite_token=...`」へ分岐し、既存アカウントでも招待参加できるようにした。
- Why: 実運用では「既存ユーザーが別ワークスペースに招待される」ケースが多く、再登録を強制しない方が自然なため。

- Decision: 設定画面の招待リンク管理に `コピー` と `無効化` を追加し、発行後運用をUIで完結できるようにした。
- Why: URL共有の実務導線を短縮し、誤発行時に即時停止できる安全運用を可能にするため。

- Decision: Unified Business Ledger強化として `business_cases.stage`（`intake/drafting/awaiting_approval/approved/executing/exception/blocked/completed`）を追加し、案件の進捗をタスク群から導出する方式を採用した。
- Why: `status(open/blocked/closed)` だけでは実務上の進行度が見えないため、案件単位の「今どこで詰まっているか」を可視化するため。

- Decision: `/app/cases` に `syncCaseStagesNow` サーバーアクションを追加し、全案件のステージを再計算して `CASE_STAGE_SYNCED` を `case_events` に記録する運用にした。
- Why: 既存タスク更新フローを大きく変えずに、段階的にCase中心運用へ移行できるようにするため。

- Decision: 能動化の第一段として `monitor_runs` 台帳と `runMonitorTick` を追加し、滞留/失敗シグナルがある時のみ Planner を起動する構成にした（手動 `/app/monitor` + API `/api/monitor/run`）。
- Why: 無駄な定期推論を抑えつつ、異常や滞留の検知時には自動で提案生成へつなぐため。

- Decision: 監視APIの認可は `x-monitor-token` (`MONITOR_RUN_TOKEN`) とし、Cronでは未設定時に `PLANNER_RUN_TOKEN` をフォールバック利用する。
- Why: 既存運用のトークン管理を壊さずに監視ジョブを追加できるようにするため。

- Decision: `runMonitorTick` はシグナル検知時に共有チャットへ system nudge（回収推奨メッセージ）を自動投稿する。投稿可否は `MONITOR_CHAT_NUDGE_ENABLED` で制御する。
- Why: 「止まらず回収して進める」を実運用に落とし込み、監視結果をそのまま人間の最短導線（チャット）へ接続するため。

- Decision: `/app/monitor` に「即時回収アクション」を追加し、承認催促（guarded reminder）・失敗workflow再試行・滞留案件の自分割当をワンクリック実行できるようにした。
- Why: 監視で異常を検知しても運用者が次アクションへ遷移する手間が残るため、回収オペレーションを同一画面で完結させるため。

- Decision: 監視チャット通知は件数だけでなく `signal_samples`（滞留タスク名・滞留案件名・失敗タスクIDなど）を添えて投稿し、次に触る対象を即判断できる形にした。
- Why: 「検知はしたが対象が分からない」状態をなくし、監視→回収のリードタイムを短縮するため。

- Decision: チャット本文中の `https://...` と `/app/...` はクリック可能リンクとして描画し、監視通知の対象リンクから直接遷移できるようにした。
- Why: 監視通知を読んだ後の遷移コストを下げ、回収アクションまでの時間を短縮するため。

- Decision: Chat intent に `monitor_recovery_run` を追加し、`@AI 監視回収を実行` で「承認催促 + 失敗workflow再試行 + 滞留案件の自分割当」をまとめて実行できるようにした。
- Why: 監視通知後の実行オペレーションを1コマンド化し、ヒューマンの操作負荷をさらに下げるため。

- Decision: `/app/monitor` に `monitor_recovery_run` 実行履歴（承認催促/再試行/割当の件数サマリ）を追加し、監視→回収の実行結果を同一画面で監査できるようにした。
- Why: 回収実行後に別ページへ遷移せず結果を確認できるようにし、運用ループを短縮するため。

- Decision: `/app/monitor` に「次の推奨アクション」セクションを追加し、最新シグナルと直近失敗結果から優先度付きの対応先リンクを自動提示する。
- Why: 失敗後に「次に何をすべきか」を即判断できるようにし、運用者の意思決定時間を短縮するため。

- Decision: 推奨アクションカードには `根拠シグナル`（件数や失敗内訳）を `<details>` で表示し、提示理由をその場で監査できる形式にした。
- Why: 推奨の妥当性を人間が即検証できるようにし、運用時の説明責任を担保するため。

- Decision: 監視の共有チャット通知にも `next_actions` を短く埋め込み、シグナル値に応じた「次に開くべきページ」を本文内で提示する。
- Why: チャットだけ見ている運用者でも、理由と次アクションを同時に把握して即遷移できるようにするため。

- Decision: 監視の推奨判定ロジックは `lib/monitor/recommendations.ts` に共通化し、`/app/monitor` とチャット通知で同じ基準を使うようにした。
- Why: 画面表示と通知本文で推奨内容がずれる運用リスクを避け、一貫した判断基準を維持するため。

- Decision: `monitor_recovery_run` に org単位の安全ガード（同時実行スキップ + クールダウン）を追加し、`MONITOR_RECOVERY_COOLDOWN_SECONDS`（default 90s）で連打を抑制する。
- Why: 監視回収を短時間で重複実行すると同じ催促/再試行/割当が連発され運用ノイズになるため、チャット実行レイヤーで先に抑止するため。

- Decision: タスク状態遷移（承認依頼/承認決定/自動承認）時に `syncCaseStageForTask` を呼び出し、`business_cases.stage` を都度再計算して `CASE_STAGE_SYNCED` を記録する。
- Why: 手動同期ボタン依存を減らし、ケース台帳をリアルタイムに近い状態で維持して監視・回収判断の精度を上げるため。

- Decision: `monitor_recovery_run` の workflow再試行は単発失敗で終えず、`MONITOR_RECOVERY_WORKFLOW_RETRY_PASSES`（default 1）分だけ追加パスで再試行し、`recovered_on_extra_pass` と失敗IDを結果に残す。
- Why: 一時的なロック/順序依存で初回失敗するケースを回収し、運用者の手動再実行を減らすため。

- Decision: 監視ページの回収履歴サマリに `extra_recovered` を表示し、追加再試行の効果を可視化する。
- Why: 自動リカバリ施策の有効性を運用者が一目で判断できるようにするため。

- Decision: 監視回収の workflow 再試行失敗は `retryable/manual` に分類して結果へ保存し、monitor画面で分類件数を表示する方式にした。
- Why: すぐ再試行すべき一時障害と、人手で原因確認すべき恒常障害を分離し、運用者の次アクション判断を速くするため。

- Decision: `/app/operations/exceptions` に「監視回収で手動対応判定された失敗」セクションを追加し、`monitor_recovery_run` の `failed_details.reason_class=manual` を優先表示する。
- Why: 監視回収後に再試行不能な失敗を埋もれさせず、例外トリアージ画面で即対応できるようにするため。

- Decision: 監視回収の manual 失敗は `reason_summary` を軽量分類（auth/policy/input/connector/unknown）し、`/app/operations/exceptions` で理由別の推奨アクション導線を表示する。
- Why: 手動対応時の初動（どの画面を開き何を確認するか）を標準化し、復旧までの時間を短縮するため。

- Decision: `/app/monitor` に「手動対応が必要な失敗（優先3件）」を追加し、`monitor_recovery_run` の manual 判定から workflow詳細/例外キューへ直接遷移できるようにした。
- Why: 監視画面だけ見ている運用者でも、再試行不能な失敗を即トリアージできるようにするため。

- Decision: 自律実行ガードを強化し、`GOVERNANCE_HIGH_RISK_THRESHOLD` 以上は2名承認（タスク作成者除外）を必須化、さらに `GOVERNANCE_HOURLY_SEND_EMAIL_LIMIT` で rolling 1時間の実行上限を導入した。
- Why: 高リスク操作の暴走を抑止し、短時間の連続実行による外部影響を制限するため。

- Decision: `monitor_recovery_run` で manual 判定された workflow 失敗は `exception_cases(kind=failed_workflow)` を自動 upsert し、`MONITOR_RECOVERY_EXCEPTION_SLA_HOURS` を期限に設定する方式を導入した。
- Why: 監視回収の失敗をその場で運用キューへ接続し、見落としなく担当/期限付きで追跡できるようにするため。

- Decision: workflow orchestrator の失敗時に `exception_cases(kind=failed_workflow)` を自動 upsert し、`WORKFLOW_FAILURE_EXCEPTION_SLA_HOURS` で期限を設定するようにした。
- Why: ワークフロー失敗が発生した瞬間に例外運用キューへ接続し、再試行・原因調査の責任追跡を自動化するため。

- Decision: `/app/approvals` に `high_risk_only` フィルタを追加し、risk_assessments と最新イベントから高リスク推定した上で「必要承認数に未達」の pending 承認を専用キューとして表示する。
- Why: 高リスク案件の承認不足を通常キューから即切り出し、二段承認の遅延を最小化するため。

- Decision: `/app/approvals` に「高リスク承認不足を再通知」アクションを追加し、pending承認のうち required approvals 未達だけを抽出して Slack 再通知する運用を追加した。
- Why: 高リスク案件の承認遅延をワンクリックで圧縮し、二段承認フローの処理速度を上げるため。

- Decision: トップ `/app` に高リスク承認不足カードを追加し、件数表示とワンクリック再通知（Slack）を可能にした。
- Why: ダッシュボード起点で高優先承認遅延へ即対応できるようにし、二段承認の滞留時間を縮めるため。

- Decision: 承認カードに「追加承認候補」を表示し、承認不足時は表示名ベースで候補メンバーを提示する方式を追加した（IDは非表示）。
- Why: 高リスク案件で「次に誰へ依頼すべきか」を即判断できるようにし、二段承認の回収速度を上げるため。

- Decision: 承認判定ロジックを強化し、高リスク時は1件目の approved でもタスクを `ready_for_approval` 維持にして、必要承認数に達した時のみ `approved` へ遷移させる方式に変更した。
- Why: 二段承認ルールを実行直前ではなく承認フロー本体で担保し、誤って早期に実行可能化されるリスクを減らすため。

- Decision: `/app/tasks/[id]` に承認進捗カード（required/current/remaining）を追加し、実行可否の近くで二段承認の充足状態を明示するUIにした。
- Why: 「なぜ実行できないか」を承認件数で即理解できるようにし、承認回収アクションへ素早く移れるようにするため。

- Decision: Slack 承認アクションの応答文言を二段承認対応に変更し、未達時は「一次承認（追加承認待ち）」、充足時は「最終承認完了」を返すようにした。
- Why: Slack上で承認者が現状ステータスを誤解しないようにし、追加承認の取りこぼしを減らすため。

- Decision: 承認イベントの監査性向上として `HUMAN_APPROVED/HUMAN_REJECTED` と `TASK_UPDATED` payload に `approval_stage`（partial/final/rejected）と承認ガード情報を記録するようにした。
- Why: 一次承認と最終承認の差分をイベント台帳だけで判別できるようにし、証跡・監査の解像度を上げるため。

- Decision: Evidence Pack の承認セクションに `HUMAN_APPROVED/HUMAN_REJECTED` 由来の `approval_stage` 監査一覧を追加し、partial/final/rejected の遷移を時系列で表示するようにした。
- Why: 承認テーブルの最終状態だけでは二段承認の進行が追えないため、監査レポート単体で承認段階の履歴を確認できるようにするため。

- Decision: インシデント時の停止挙動を統一するため、Planner 実行（`/app/planner` サーバーアクションと `/api/planner/run`）にも open incident ガードを追加し、宣言中は実行をスキップする方式にした。
- Why: チャット経由では `run_planner` が停止されるのに UI/API で動く不整合を解消し、危険時の運用ルールを全経路で一貫させるため。

- Decision: `monitor` tick はインシデント中でもシグナル収集と監視記録は継続しつつ、Planner起動のみを自動スキップする方式にした（summary_json に `blocked_by_incident` と incident 情報を記録）。
- Why: 異常時でも可観測性を維持しながら、自律提案の増幅だけを止めることで「見えるけど暴走しない」安全運用を実現するため。

- Decision: 運用可視化として `/app/executions` に incident 起因ブロック（`metadata_json.blocked_by_incident`）の専用フィルタ/件数カード/行バッジを追加し、`/app/operations/jobs` にも monitor の incident スキップ件数カードを追加した。
- Why: 「止まっている理由」を監査ページ横断で統一表示し、インシデント時の停止が期待通り機能しているかを運用者が即確認できるようにするため。

- Decision: チャットの `@AI` 起動判定をメンショントークン正規化（`NFKC + lower`）で統一し、`@AI` は人間メンション解決対象から除外した。さらにチャンネル投稿時は投稿前に明示的な membership チェックを追加した。
- Why: `@AI` がユーザーハンドル解決と衝突して誤通知/誤実行になるリスクを防ぎ、チャンネル権限不足時にRLSエラーではなく明確な業務エラーメッセージで安全に停止するため。

- Decision: チャット監査 (`/app/chat/audit` + export API) に `ai` フィルタ（mentioned/non_mentioned）を追加し、`chat_intents.message_id` から `chat_messages.metadata_json` を参照して `@AI` 起点と mentions を可視化する方式にした。scope フィルタも `channel` を含めた。
- Why: 「AIを呼んだ投稿か/通常会話か」を監査で即分離できるようにし、誤作動や運用逸脱のトリアージ時間を短縮するため。

- Decision: インシデントモードで confirmation 実行を止めた場合でも `ai_execution_logs` に `execution_status=skipped` + `blocked_by_incident=true` を記録するようにした。
- Why: 実行前ブロックが `chat_commands` に残らないケースでも、停止実績を実行台帳側で確実に監査できるようにするため。

- Decision: `/app/chat/audit` の各行に `task` に加えて `evidence` / `channel` への直接リンクを追加し、failed 再実行フォームも channel scope を正しく引き継ぐようにした。
- Why: チャット監査から証跡・会話文脈への遷移を1クリック化し、調査と再実行の往復コストを下げるため。

- Decision: `/app/chat/audit` に `intent × skip_reason × incident_blocked` の集計マトリクスを追加し、上位 intent / skip reason の詰まり分布を可視化した（フィルタ適用後データで集計）。
- Why: 単発ログの閲覧だけでなく「どこで詰まりが集中しているか」を一覧で把握し、改善対象の優先順位付けをしやすくするため。

- Decision: マトリクスの各セル値をクリック可能にし、intent/skip_reason を引き継いだ監査フィルタへ直接遷移できるようにした（0件は非リンク）。
- Why: 可視化で終わらせず、該当ログの掘り下げまで最短導線にして、調査フローを短縮するため。

- Decision: `/app/chat/audit` に分析期間フィルタ `window`（24h/7d/30d）を追加し、skip集計・詰まりマトリクス・incident blocked件数・比率表示を同一期間で計算するように統一した。export API も同じ `window` で抽出するようにした。
- Why: 短期障害（24h）と慢性的な詰まり（30d）を同じ画面で切り替えて比較できるようにし、対処優先度の判断精度を上げるため。

- Decision: `/app/executions` にも監査プリセット期間 `window`（24h/7d/30d）を追加し、from/to の初期値と incident blocked 表示・CSV出力条件を同一 window で揃えた。
- Why: 監査ページ間の操作感を統一し、都度日時入力せずに同じ時間軸で実行台帳を比較できるようにするため。

- Decision: `/app/operations/jobs` も `window`（24h/7d/30d）を searchParams で受け取り、planner/review/alert/retry/incident/monitor の各クエリに `created_at >= windowStart` を適用した。フィルタUI・見出しにも window を表示する方式にした。
- Why: ジョブ監査だけ別時間軸になる不整合を避け、`chat audit`・`executions` と同じ期間感で原因分析できるようにするため。

- Decision: `/app/monitor` と `/app/approvals` にも `window`（24h/7d/30d）を追加し、monitor_runs / monitor_recovery_run / approvals週次集計 / reminderイベント / auto guard表示を同一 window で表示するようにした。
- Why: 主要監視画面の時間軸を統一し、「どの画面でも同じ期間を見ている」状態で運用判断できるようにするため。

- Decision: `monitor/approvals` の server actions 実行後リダイレクトでも `window` を保持するため、actions 側で `window` を受け取って query へ再付与する方式にした。対応フォームには hidden `window` を追加した。
- Why: ボタン実行のたびに期間が `7d` に戻る挙動を防ぎ、調査中の時間軸を維持したまま運用アクションを繰り返せるようにするため。

- Decision: ダッシュボード `/app` も `window`（24h/7d/30d）を正式対応し、主要メトリクス文言・チャット監査導線・クイックアクションの return 先・関連ページリンクに同一 `window` を引き回すように統一した。
- Why: トップ画面だけ7日固定のままだと、他監査画面との比較で期間ズレが発生するため。期間を跨いだ運用判断ミスを防ぐためにも、ホームから遷移後まで同一時間軸を保持する。

- Decision: `retryTopFailedWorkflowRuns` に `return_to` を追加し、`/app` など呼び出し元画面へ結果付きで戻せるようにした（`/app` 配下のみ許可）。
- Why: ダッシュボードのクイックアクション実行後に文脈（期間フィルタ/画面）を維持して連続対応できるようにするため。open redirect を避けるため遷移先は `/app` 配下に限定する。

- Decision: 組織コンテキストの可視性強化として `/app/workspace` を追加し、ワークスペース名・メンバー（表示名/ハンドル/ロール）・有効な招待リンクを一画面で確認できるようにした。ナビゲーションとホームにも導線を追加した。
- Why: 「同じ所属で何を共有しているか」を常時明確にし、招待やメンバー把握を設定ページに埋もれさせず、協業運用を始めやすくするため。

- Decision: `/app/proposals` と `/app/planner` は `task_proposals` / `planner_runs` 未適用時に即 throw せず、空配列表示 + migration案内バナーを出すフォールバックに変更した。
- Why: 初期導入や環境差分で migration が一部未適用でも、対象ページだけ500で落ちる状態を避け、利用者が次に実行すべき復旧手順（`supabase db push`）を画面上で即把握できるようにするため。

- Decision: `/app/governance/recommendations` とその actions を `window`（24h/7d/30d）対応にし、集計・履歴表示・改善提案の遷移先・実行後リダイレクトで同一期間を保持するようにした（`buildGovernanceRecommendations` に `windowHours` オプションを追加、未指定時は7日）。
- Why: 改善提案だけ7日固定だと、他監視画面（approvals/executions/chat audit）との比較で時間軸がズレるため。対策の優先順位判断を期間一貫で行えるようにするため。

- Decision: `/app/governance/recommendations` の表示ラベル（優先度、KPIカード、レビュー要約、履歴比較）を日本語中心に統一し、期間ラベルも `windowLabel`（24時間/7日/30日）で表示するようにした。
- Why: 日本語運用を前提にした現場で英語ラベルが混在すると認知負荷が高く、監視・判断の速度が落ちるため。運用画面は即読性を優先する。

- Decision: `/app/planner` の英語メトリクス/履歴ラベル（run completed, started_at, summary_json など）を日本語化し、プランナー監視画面の文言を日本語運用前提で統一した。
- Why: プランナーは日常監視で頻繁に見るため、英語ラベル混在を減らして異常検知と判断のスピードを上げるため。

- Decision: `/app/executions` のフィルタ/集計カード/行メタ情報の英語ラベルを日本語化し、状態・起点の表示もラベル変換（done→成功 など）で統一した。
- Why: 実行監査は運用中に最も参照頻度が高く、英語混在や曖昧表現があると一次切り分けの速度を落とすため。表示名がない依頼元はID表示に戻さず「表示名未設定メンバー」で扱う方針を維持する。

- Decision: `/app/operations/exceptions` でも担当者表示を `user_profiles.display_name` 優先にし、ID生表示（case id / owner user id / fallback task_id）を運用UIから減らす方針にした。英語ラベルも日本語化し、`Evidence` などは「証跡」へ統一した。
- Why: 例外キューは現場オペレーションで最も人間が触る画面の一つであり、ID中心表示は判断速度を下げるため。表示名ベースに寄せて、必要な識別子は遷移先URL内部に留める。

- Decision: `/app/tasks/[id]/evidence` でもユーザー識別は `display_name` 優先表示にし、タスクID/ケースID/approval_id/event_id などの生ID表示を監査閲覧UIから削減した（証跡JSON内の参照は維持）。
- Why: 証跡パックは監査・運用レビューで人が読む文書であり、ID列挙よりも誰が何をしたかの可読性が重要なため。必要な機械識別子はデータ自体に残しつつ、画面表示は意味中心にする。

- Decision: `/app/tasks/[id]` の承認履歴にも `user_profiles.display_name` を適用し、依頼者/承認者を表示名で表示するようにした。タスク起票元バッジも raw source 文字列ではなく日本語ラベルへ変換した。
- Why: タスク詳細は日常運用の中核画面であり、「誰が承認したか」「どこ起点のタスクか」を即読できることが優先。内部値（source enum / user_id）をそのまま見せる必要はないため。

- Decision: `ChatShell` のメンション候補は `mention_handle` が設定されたメンバーのみ表示し、`member` 固定値や user_id 由来フォールバックは廃止した。チャンネル一覧/詳細のメンバー名フォールバックも「表示名未設定メンバー」に統一した。
- Why: 解決不能なメンション候補（`@member` など）を出すと誤投稿や通知漏れの原因になるため。ID由来フォールバックを避け、表示名中心の運用方針と整合させるため。

- Decision: `/app/operations/jobs` の監視UIは、運用カード・フィルタ・履歴見出しを日本語へ統一し、`window` 表示は `24時間/7日/30日` の明示ラベルで示す方式にした。あわせて Planner/Governance/Ops Alert/Auto Incident の一覧から event/run の生ID表示を外し、状態は日本語ラベル（成功/失敗/実行中など）で表示する。
- Why: 運用ジョブ画面は一次監視の入口であり、英語ラベルやID中心表示は判断速度を落とすため。可読性を優先しつつ、監査に必要な詳細は payload JSON と遷移先に残すのが実務上バランスがよい。

- Decision: `/app/monitor` でも `window` 表示を `24時間/7日/30日` の明示ラベルへ統一し、実行ステータス（completed/failed/skipped/running）は日本語（成功/失敗/スキップ/実行中）で表示する方針にした。
- Why: 監視運用ページ間で期間表記とステータス表記が揺れると一次対応時に見間違いが起きやすいため。`operations/jobs` と同じ語彙へ揃えることで判断負荷を下げる。

- Decision: `/app/approvals` は期間ラベルを `24時間/7日/30日` に統一し、集計カード・Auto Guard・リマインド起点（manual/cron）を日本語表示へ変更した。承認更新confirm文も internal status 名（approved/rejected）を画面文言から排除した。
- Why: 承認運用は現場担当の操作頻度が高く、英語混在や内部ステータス名の露出は誤操作リスクを上げるため。業務語彙に寄せることで判断コストを下げる。

- Decision: `/app/governance/incidents` と `/app/governance/trust` の主要ラベル（severity/provider/action_type/score/updated_at 等）を日本語運用向けに統一し、日時表示は `ja-JP` フォーマットで揃えた。
- Why: ガバナンス配下のページ間で表示語彙が揺れると、監視時の読み替えコストが発生するため。インシデントとTrustは意思決定直結画面なので即読性を優先する。

- Decision: `/app/governance/autonomy` は `Trust score` 表記を「信頼スコア」に統一し、MVPルール文言も「ON」などUI由来語ではなく日本語中心（有効）へ寄せた。
- Why: 自律設定は非エンジニアが直接触る画面のため、英語/実装語彙の混在を避け、誤読を減らすため。

- Decision: `/app/governance/budgets` は `provider/action_type/period` の生値表示をラベル変換（Google/Slack、メール送信、日次）して表示する方針にした。
- Why: 予算ページは運用担当の閲覧中心であり、内部enum値を直接表示するより業務語で示したほうが理解が速く、設定ミス防止につながるため。

- Decision: `/app/governance/recommendations` は `action_kind` / `actor_type` / `metricLabel` などの内部値をそのまま表示せず、日本語ラベルへ変換する表示層（`actionKindLabel`, `actorTypeLabel`, `metricLabelJa`）を追加した。
- Why: 改善提案画面は運用判断の中心であり、内部enumの生表示は理解速度を落とすため。監査上の原値はイベントpayloadに残しつつ、UIは業務語で統一する。

- Decision: `/app/chat/audit` は監査UIの表示層で `status/scope/intent/skip_reason/ai` を日本語ラベルへ変換し、フィルタチップ・集計カード・マトリクス見出し・一覧行バッジまで同じ語彙で統一した。`command_id` の生表示は削除した。
- Why: チャット監査は非エンジニア含む運用者が一次トリアージに使うため、内部enumやIDの生表示よりも意味ラベルを優先した方が対応速度と誤判定防止に有効なため。

- Decision: `/app/workflows` / `/app/workflows/runs` / `/app/workflows/runs/[id]` は run status・step type・見出し文言を日本語化し、日時表示を `ja-JP` に統一した。
- Why: ワークフロー障害対応時に英語と実装値の混在があると判断が遅れるため。業務視点のラベルで統一しつつ、必要な技術詳細はJSON詳細に残す方針とした。

- Decision: `ChatShell`（共有/個人/チャンネル共通UI）の監査補助表示で、`skip_reason`・`quick`・`result_json`・`finished` などの英語ラベルを日本語へ統一した。確認ボタン文言も `Yes/No` を日本語化した。
- Why: チャット実行の一次確認は本画面で行うため、英語混在があると承認判断のスピードが落ちる。監査詳細はJSONに残しつつ、操作面は日本語優先に寄せる。

- Decision: `integrations/slack` / `integrations/google` はコネクタ状態カードと設定手順の表示語彙を日本語運用向けに統一し、`connected_at` などの時刻は `ja-JP` 表示に揃えた。
- Why: 連携設定は導入初期に最も詰まりやすい画面のため、英語混在を減らして設定ミスと問い合わせコストを下げるため。

- Decision: `settings` の招待リンク一覧でも `expires/uses` 表記を日本語化し、日時を `ja-JP` 表示に統一した。
- Why: 招待運用は管理者の非エンジニア利用が多く、英語略語よりも日本語ラベルの方が状態把握が速いため。

- Decision: 主要一覧ページ（`/app/tasks`, `/app/agents`, `/app/executions`）は内部enumの生表示を避け、表示ラベル関数で日本語化する方針を適用した（例: task status/source, agent status, execution scope/intent/ref）。
- Why: 一覧画面は現場オペレーションで最も参照頻度が高く、内部値の露出は認知負荷と読み間違いを増やすため。監査上の原値はDBに保持しつつ、UIは業務語で統一する。

- Decision: ダッシュボードのナビゲーション語彙も合わせて調整し、`Trust` は `信頼スコア` へ統一した。
- Why: トップ画面の導線語彙は全画面の基準になるため、語彙ブレを早期に潰して学習コストを下げるため。

- Decision: `/app` ダッシュボードの優先対応キューと改善提案セクションで重複表示を解消し、`auto/block/open/intent` などの英語混在を日本語運用語彙へ統一した。あわせて提案カードの `priority/metric` とタスク分布の `status` はラベル変換関数を必ず通す実装に固定した。
- Why: ダッシュボードは現場が最初に見る画面であり、同義語の重複表示や英語混在があると一次判断が遅れるため。表示層でのラベル変換を必須化して、今後の機能追加時にも語彙ブレを抑える。

- Decision: `/app/proposals` と `/app/workspace` でも内部値（`pass/warn/block`, reason code, source, role）の生表示を避け、表示ラベル関数で日本語化する方針を適用した。日時表示は `ja-JP` を統一し、招待リンク情報の `expires/uses` など英語語彙を排除した。
- Why: 提案審査とワークスペース管理は非エンジニア運用者の利用頻度が高く、内部コード値の露出が判断遅延と誤読を招くため。UIを業務語彙へ寄せて運用負荷を下げる。

- Decision: `/app/chat/channels` は「新規チャンネル」導線を折りたたみ化して主画面からの圧迫を減らし、参加中チャンネル/DM数の要約表示を追加した。`/app/executions` はチャンネル絞り込みを追加し、行表示の `channel_id` はチャンネル名へ解決して表示する。
- Why: 日常利用で最も触るチャット画面は作成フォームの常時表示より閲覧性を優先した方が使いやすく、実行監査では「どのチャンネル発の実行か」を即時に追えることが運用上重要なため。

- Decision: `ChatShell` と `/app/chat/channels/[id]` は、絵文字依存の話者アイコン（🤖/👤）を廃止して文字ベースアバター（AI/イニシャル）へ統一し、インシデント重大度とチャネル種別も日本語ラベル化した。日時表示は `ja-JP` を基本とする。
- Why: 監査・業務UIで装飾的絵文字より識別性を優先し、表示語彙を業務日本語へ揃えることで読み取り負荷を下げるため。

- Decision: `/app/governance/trust` は見出しを「信頼スコア」に統一し、`provider/action_type` の生値表示をラベル化（例: `send_email` → 「メール送信」）した。`ChatShell` のワークスペース名フォールバックは `org_id` 表示をやめ、名称未設定ラベルを表示する。
- Why: 運用UIで内部キーやIDを直接見せると可読性が落ちるため。監査上の原値はDBに残しつつ、画面は意味ラベル中心で統一する。

- Decision: `/app/chat/audit` の詰まりマトリクスは `other/none` の内部語彙を「その他/スキップなし」に変換し、意図サマリの未設定表示も日本語（要約なし）へ統一した。
- Why: 監査画面は一次トリアージ用途のため、英語キーや実装都合の文字列を残さず、判断に直結する語彙で表示する方が実務上有効なため。

- Decision: `ChatShell` と `/app/chat/audit` のクイックアクション表示は `request_approval` など内部キーの生表示を廃止し、日本語ラベル（承認依頼/アクション実行/ワークフロー実行等）へ変換して表示する。
- Why: チャット運用時の「何を実行しようとしているか」を非エンジニアでも即読できるようにし、確認判断ミスを減らすため。

- Decision: ガバナンス提案文言（`lib/governance/recommendations.ts`）の英語混在を整理し、`Trust/Policy/block/min_trust_score/Evidence` などの語彙は「信頼スコア/ポリシーブロック/最小信頼スコア/証跡」に統一した。`/app/governance/recommendations` の履歴説明も `baseline` ではなく「基準値」表現に変更した。
- Why: 改善提案は運用意思決定の中心であり、実装用語が混在すると解釈ミスが起きやすいため。業務語彙へ統一して可読性を維持する。

- Decision: `/app/operations/jobs` は運用監視カードと履歴ラベルの英語混在（Planner/Workflow Tick/payload JSON/trigger など）を日本語語彙へ統一し、ジョブサーキット状態の表示は `resumeStageLabel` で一元化した。`/app/workflows` 系も補助文言を日本語へ揃えた。
- Why: 運用監視画面は一次障害対応の入口であり、英語混在や同義語の揺れがあると判断速度が落ちるため。表示語彙を統一してトリアージの負荷を下げる。

- Decision: `/app/operations/exceptions` の運用操作文言（`workflow/manual/run/due` など）を日本語へ統一し、日時表示は `ja-JP` に寄せた。確認ダイアログ文言も「ワークフロー実行」表記に揃えた。
- Why: 例外対応画面は即時オペレーションで使うため、英語混在や内部語彙が残ると誤読しやすい。表示語彙を統一し、一次対応速度を優先する。

- Decision: `/app` トップに「主要導線」ショートカット帯（承認キュー/例外キュー/チャット監査/ジョブ監視）を追加し、運用起点画面へ1クリックで遷移できる構成にした。あわせて `Operations Console` や `Workspace` など残り英語ラベルと重複表示を解消した。
- Why: ダッシュボードが情報密度の高い画面になっているため、運用者が「次に開く画面」を迷わない導線を明示する方が実務で有効なため。

- Decision: `/app/operations/exceptions` のフィルタUIで `export/payload` 表現を「出力/詳細JSON」へ統一し、ケース一覧の `kind` 生値（`failed_action` など）は表示層で日本語ラベルへ変換する方針にした。
- Why: 例外キューは非エンジニア運用者が直接触るため、内部キーや英語混在のままだと判断コストが上がるため。

- Decision: 招待リンク運用は `/app/settings` だけでなく `/app/workspace` からも直接実行できるようにし、`createWorkspaceInviteLink` / `revokeWorkspaceInviteLink` は `return_to` を受け取って呼び出し元へ戻る仕様にした。
- Why: ワークスペース管理の主画面で作成/無効化まで完結できた方が運用導線が短く、管理者の往復操作を減らせるため。

- Decision: `/app/chat/channels/[id]` に「運用ショートカット」帯を追加し、チャンネル起点で `実行履歴/チャット監査/例外キュー/タスク一覧` へ即時遷移できるようにした。メンバー招待は候補ゼロ時に空フォームではなく説明メッセージを表示する。
- Why: チャンネル運用中に監査・例外対応へ遷移する回数が多いため、1クリック導線を置く方が実運用で速い。空フォーム表示は誤操作を招くため回避する。

- Decision: `/app/executions` は `channel` フィルタが有効なときに「チャンネル絞り込み中」コンテキストカードを表示し、`チャンネルへ戻る` と `絞り込み解除` の導線を明示する。CSV導線ラベルは `CSV出力` に統一した。
- Why: 実行監査はチャンネル起点の調査往復が多く、現在どのチャンネル文脈で見ているかを明示しないとナビゲーションミスが起きやすいため。導線を上部に固定することで調査速度を上げる。

- Decision: `ai_execution_logs` の監査性を高めるため、`/app/executions/[id]` を新設し、一覧から各実行の詳細（状態・起点・スコープ・参照先・メタデータ）を1件単位で追跡できる構成にした。
- Why: 障害調査や監査対応では一覧だけでは根拠不足になりやすく、個別実行の証跡を即時に確認できる詳細画面が運用上必須なため。

- Decision: `/app/chat/audit` に `session_id` 直指定フィルタを追加し、URL共有・CSV/JSON出力・フィルタ要約へも同値を反映する。`/app/executions/[id]` からは `session_id` 付きで監査ページへ遷移する。
- Why: 実行詳細からチャット監査へ往復する際にセッション単位で絞れないと調査対象が広すぎるため。1セッション固定で追える導線を標準化してトリアージ時間を短縮する。

- Decision: `/app/chat/audit` 内の状態チップ・意図別失敗率・詰まりマトリクス・skip理由リンクなど、`buildAuditFilterHref` を使う遷移はすべて `session_id` を保持する仕様に統一した。
- Why: セッション固定で調査している途中にリンク遷移でセッション条件が外れると、再現確認と原因追跡の効率が落ちるため。

- Decision: `/app/executions/[id]` の task参照導線は「タスク詳細」と「証跡パック」を分離表示し、実行監査から Evidence Pack へ直接遷移できる構成にした。
- Why: 監査実務ではタスク画面を経由せず証跡を直接開く頻度が高く、導線分離の方が調査時間を短縮できるため。

- Decision: `/app/executions` 一覧でも task参照行に「証跡」リンクを追加し、`session_id` を取得して「チャット監査」への直リンクを設置した。
- Why: 実行一覧から詳細ページを挟まずに証跡・監査へ飛べる方が一次トリアージが速く、障害時の調査フローを短縮できるため。

- Decision: `/app/tasks/[id]/evidence` は `execution_id` クエリを受け取り、指定がある場合のみ「実行履歴へ戻る」導線を表示する。実行一覧/詳細から証跡へ遷移するリンクには `execution_id` を付与する。
- Why: 実行監査と証跡確認を往復するときに起点へ戻りやすくし、監査担当のナビゲーションコストを減らすため。

- Decision: `/app/chat/audit` は `chat_commands.id` と `ai_execution_logs.metadata_json.command_id` を照合して、各行に「実行履歴詳細」リンクを表示する。照合クエリは `source=chat` と command一覧の最古時刻以降を取得してマッピングする実装にした。
- Why: チャット監査から実行台帳へ1クリックで遷移できるようにしつつ、JSONパス条件のDB互換性差分を避けて安定動作させるため。

- Decision: `/app/chat/audit` の状態フィルタ対象に `declined`（却下）と `skipped`（スキップ）を追加し、集計カードとバッジ表示も対応させた。
- Why: 確認キャンセルやガードによる停止は失敗と性質が異なるため、専用ステータスで監査できるようにした方が運用判断が速くなるため。

- Decision: `/app/executions` も `declined`/`skipped` の集計カードを独立表示し、一覧行の状態バッジ色を `chat/audit` と同系統に統一した。
- Why: 実行台帳とチャット監査でステータスの見え方が揃っていないと、運用者が画面をまたいだ際に判断ミスしやすいため。

- Decision: `/app/executions` に `session_id` 直指定フィルタを追加し、入力時はセッション固定表示のコンテキストを上部に出す仕様にした。
- Why: 実行台帳単体でもチャットセッション起点の追跡を完結できるようにし、監査画面との往復を減らすため。

- Decision: `/api/executions/export` は `session_id` を含む実行履歴フィルタ（`source/status/requester/scope/intent/channel/incident`）を受け取り、一覧画面と同条件でCSV出力する仕様にした。CSV列にも `session_id` を追加した。
- Why: 画面表示とCSV出力の条件が一致しないと監査提出時に差分が発生するため。条件一致を仕様化して再現性を担保する。

- Decision: `runMonitorTick` の planner 起動判定を `total_signals>0` の単純条件から、`signal_score >= MONITOR_MIN_SIGNAL_SCORE` かつ `MONITOR_PLANNER_COOLDOWN_MINUTES` を満たす方式に変更した。`force_planner=1` は従来通り優先して起動し、インシデント中は常に停止する。
- Why: シグナルが少量でも毎ティック起動すると提案ノイズが増え、運用負荷が上がるため。スコア閾値とクールダウンで「必要時のみ起動」を実現する。

- Decision: monitor の skip 時チャットナッジは `incident_open` のみ投稿し、`no_signals`・`below_score_threshold`・`planner_cooldown` は抑止する。
- Why: クールダウンや軽微シグナル時に毎回通知すると共有チャットがノイズ化するため。重大停止のみ通知して運用集中を維持する。

- Decision: `runPlanner` に提案デデュープを追加し、`PLANNER_PROPOSAL_DEDUPE_HOURS`（既定24h）内の `proposed/accepted/executed` 提案と同一キー（title + to + subject + body_text）を検知した場合は新規作成せず `PROPOSAL_SKIPPED_DUPLICATE` イベントだけ記録する。
- Why: 監視ティックや手動実行が重なったときに同一提案が連続生成されると、承認キューがノイズ化するため。短時間の重複を抑えて運用負荷を下げる。

- Decision: monitor/planner の運用閾値（`monitor_stale_hours`, `monitor_min_signal_score`, `monitor_planner_cooldown_minutes`, `planner_proposal_dedupe_hours`）を `org_autonomy_settings` に追加し、`/app/monitor` から保存可能にした。ランタイムはDB値を優先し、列未適用時はenvへフォールバックする。
- Why: 組織ごとに運用負荷とシグナル密度が異なるため、コード変更なしで閾値調整できる状態が必要。RLS配下のorg設定へ寄せることでマルチテナント運用に適合する。

- Decision: `/app/monitor` の閾値更新操作は `ai_execution_logs` に `intent_type=monitor_settings_update` で記録し、成功/失敗と変更差分（before/after）を監査可能にした。
- Why: 自律起動条件の変更は運用影響が大きいため、誰がいつ何を変更したかを実行台帳で追跡できるようにする必要があるため。

- Decision: `/app/monitor` に「設定変更監査」セクションを追加し、`monitor_settings_update` の直近ログ（実行結果・実行者・変更差分）を画面内で確認できるようにした。詳細追跡は `/app/executions` への絞り込みリンクで遷移可能とした。
- Why: 閾値変更の確認で都度実行履歴ページへ移動する運用は手間が大きく、監視画面内で一次確認を完結できる方が実務上効率的なため。

- Decision: `runMonitorTick` は提案台帳にも監査イベントを記録するため、`proposal_events` に `MONITOR_DECISION_RECORDED` / `MONITOR_TICK_FINISHED` を追加記録する方式にした。`/app/planner` で直近イベントを参照表示し、monitorとplannerの相互参照を可能にした。
- Why: 監視トリガー判断と提案生成結果を別画面で追うだけだと因果関係が見えにくいため。提案台帳側にも判定ログを残すことで運用レビューの一貫性を上げる。

- Decision: `/app/monitor` は `monitor_run_id` クエリで実行履歴を絞り込めるようにし、`/app/planner` の監視判定イベントから同ID付きリンクで遷移できる導線を追加した。
- Why: planner側で気づいた監視判定を monitor側の詳細文脈へ即時に辿れるようにし、原因追跡の往復を減らすため。

- Decision: `/app/monitor` の `planner_run_id` 表示は `/app/planner?planner_run_id=<id>` へ遷移する逆導線に変更し、`/app/planner` 側では同クエリ指定時に対象runを強調表示する仕様にした。
- Why: monitorからplannerへ戻る際も同一run文脈を維持し、相互参照の往復で対象を見失わないようにするため。

- Decision: 外部シグナル取込のMVPとして `external_events` 台帳と `/api/events/intake` を追加し、`/app/events` で受信イベントの確認・処理状態更新を行える構成にした。monitor/planner は直近24時間の `pending` inbound 件数を新シグナルとして取り込み、スコア計算と提案優先度に反映する。
- Why: メール/Slack等の外部起点を「検知→提案→承認/実行」ループへ接続する最短導線が必要だったため。まずは汎用イベント台帳で入口を一本化し、後続の個別コネクタ拡張に繋げる。

- Decision: `/api/events/intake` の認可は本番系で `x-events-token`（`EVENTS_INGEST_TOKEN`）必須、開発環境のみ緩和する方式にした。重複イベントは `(org_id, provider, external_event_id)` で冪等受理する。
- Why: 外部連携の入口は公開APIになりやすく、誤投入・再送・リトライを前提に最小限の保護と冪等性を先に確保する必要があるため。

- Decision: `/app/events` の運用UIに `source/期間/キーワード` フィルタと `/api/events/export`（CSV）を追加し、一覧表示と同じ条件で監査出力できる仕様にした。ステータス更新後もフィルタ条件を維持する。
- Why: 外部イベントの確認と監査提出を同一導線で完結できるようにし、トリアージ中の再絞り込みコストを減らすため。

- Decision: `/api/events/intake` は provider に `google` が来た場合 `gmail` へ正規化し、unique競合（同一 external_event_id 再送）発生時は既存IDを返して冪等成功扱いにする。
- Why: 送信元実装の表記揺れや同時リトライを吸収し、取込側で不要なエラーを増やさないため。

- Decision: planner の seed提案に `new_inbound_events` を組み込み、受信外部イベントのサンプルから `planner_seed_external_event` 提案を優先生成する方式にした。
- Why: 受信イベントを単なる監視シグナルで終わらせず、最短で「提案→承認→実行」フローへ乗せることで自律処理率を上げるため。

- Decision: `/app` ダッシュボードに外部イベント運用KPI（未処理件数、外部イベント提案の採用率、平均判断遅延）を追加し、閾値超過時は警告色で表示する。`/app/proposals` には提案ソースフィルタを追加して外部イベント由来の提案だけを追跡できるようにした。
- Why: 自律化の進捗を運用者が定量で追える状態にし、外部イベント起点の詰まり（未処理増加・低採用・判断遅延）を早期に検知するため。

- Decision: `external_events` に `priority/triage_note/triaged_at` を追加し、`/app/events` から未処理イベントの自動仕分け（ルールベース優先度判定）を実行できるようにした。CSV出力も `priority` フィルタを反映する。
- Why: 外部イベントの件数増加時に手動仕分けだけでは初動が遅れるため。軽量ルールで優先度を付与し、運用者が先に処理すべきイベントを即判別できるようにするため。

- Decision: planner の `planner_seed_external_event` 提案は一律文面ではなく、`event_type/summary/provider` からテンプレート分岐（経理系、障害・セキュリティ系、Slack依頼系、汎用）する方式にした。
- Why: 外部イベント起点の提案精度を上げ、受け入れ率の改善と一次対応速度の向上を狙うため。

- Decision: 外部イベントテンプレートは `planner_seed_external_event_<template_key>` の source で記録し、直近30日の accepted/rejected 実績から採用率の高いテンプレートを seed提案で優先する学習ループを追加した。
- Why: 「提案を出す」だけでなく、実際に採用されやすい提案を先に出すことで人間レビュー負荷を下げるため。

- Decision: `/app/events` から外部イベントを直接 `business_cases` に起票できる `Case化` 操作を追加し、`external_events.linked_case_id` で起票済みケースを追跡する方式にした。Case化時は `CASE_CREATED_FROM_EXTERNAL_EVENT` を `case_events` に記録し、イベント状態は `processed` へ更新する。
- Why: 例外対応の入口をイベント画面で完結させ、未処理イベントからケース管理への移行を1クリック化して初動を短縮するため。

- Decision: ナビゲーションをヘッダー中心から左サイドバー中心へ再編し、主要導線のみ常時表示・低頻度機能は折りたたみグループに集約した。ホーム画面も詳細ブロックを折りたたみ化して初期表示の情報量を削減した。
- Why: 初見ユーザーが『次に何をすべきか』を即判断できる導線を優先し、運用密度が高い機能は必要時のみ展開するUXへ寄せるため。

- Decision: PCのサイドバーは  で本体領域と独立スクロールにし、メニュー量が多い場合のみサイドバー内でスクロールする構成にした。
- Why: 本文スクロール中も主要導線を固定表示し、ナビ再探索の手間を減らすため。

- Decision:  のフィルタUIを初期折りたたみ（条件指定時のみ自動展開）へ変更し、通常利用時の情報密度を下げた。
- Why: 一覧確認が主目的の画面で、毎回フィルタ群が視界を占有しないようにして初動判断を速くするため。

- Decision: PCのサイドバーは `h-screen + sticky + overflow-y-auto` で本体領域と独立スクロールにし、メニュー量が多い場合のみサイドバー内でスクロールする構成にした。
- Why: 本文スクロール中も主要導線を固定表示し、ナビ再探索の手間を減らすため。

- Decision: `/app/events` のフィルタUIを初期折りたたみ（条件指定時のみ自動展開）へ変更し、通常利用時の情報密度を下げた。
- Why: 一覧確認が主目的の画面で、毎回フィルタ群が視界を占有しないようにして初動判断を速くするため。

- Decision: ログアウト導線は誤操作防止のため常時ボタン表示をやめ、PC/モバイル共通でプロフィールアイコンをクリックしたユーザーメニュー内に集約した。設定遷移も同メニューに統合した。
- Why: 日常操作中の誤タップを減らし、アカウント操作を一箇所に集約してUIノイズを下げるため。

- Decision: `user_profiles` に `job_title` を追加し、設定画面で表示名・役職・画像を管理できるようにした。サイドバーのユーザーメニューにも役職を表示する。
- Why: 共有ワークスペース運用では「誰が何の立場か」の文脈が重要で、承認・相談先判断を速くするため。

- Decision: ユーザーメニューに言語即時切替（日本語/English）を追加し、`/api/preferences/locale` で cookie 更新後に元ページへ戻す方式にした。
- Why: 設定画面を開かずに表示言語を切り替えられる導線を提供し、日常操作の切替コストを下げるため。

- Decision: ログアウトボタンを常時表示から撤去し、プロフィールメニュー内に集約した。モバイルでも右上アイコンから同様に操作可能とした。
- Why: 誤操作防止とUIノイズ削減を同時に満たすため。

- Decision: 高優先度（`priority=high/urgent`）の外部イベントは `runAutoCaseifyForOrg` で自動Case化できる共通処理を追加し、`/app/events` からの手動実行と `/api/events/auto-caseify` のバッチ実行で同一ロジックを利用する方式にした。
- Why: 例外系の初動を手動オペレーションに依存させず、運用ジョブからも同じ品質でケース起票できるようにするため。

- Decision: `.github/workflows/autonomy-cron.yml` に `/api/events/auto-caseify?max_orgs=<N>` の定期実行を追加し、`/app/operations/jobs` に外部イベント自動Case化のKPI・履歴・手動実行ボタンを追加した。トークンは `EVENTS_AUTOMATION_TOKEN` を優先し、未設定時は `PLANNER_RUN_TOKEN` へフォールバックする。
- Why: 高優先度イベントのCase化をイベント画面の手動操作だけに依存すると初動が遅れるため。cron実行と運用画面可視化をセットにして、検知→Case化の自律ループを常時回しつつ監査可能にするため。

- Decision: `/api/events/auto-caseify` を `runWithOpsRetry` へ統一し、`events_auto_caseify_batch` としてリトライ/サーキット制御、`skipped_circuit` / `skipped_dry_run` 返却、`OPS_JOB_*` 監査イベント記録に対応させた。
- Why: auto-caseify だけガード未適用だと定期運用時の失敗耐性と監査粒度が他ジョブより弱くなるため。既存の運用基盤に揃えて安定運用と障害分析を容易にするため。

- Decision: `/app/operations/jobs` にジョブSLOカード（Planner / Governance Review / Events Auto-Caseify / Workflow Tick）を追加し、直近ウィンドウ別に `成功率` と `MTTR`（失敗から次の成功まで平均時間）を表示する方式にした。
- Why: 件数カードだけでは運用品質の比較が難しく、復旧効率を継続改善しづらいため。成功率とMTTRを同画面で可視化し、優先的に改善すべきジョブを即判断できるようにするため。

- Decision: `/app` トップページにも運用SLO要約（Planner / Governance Review / Events Auto-Caseify / Workflow Tick）を追加し、`成功率` と `MTTR` をしきい値ベースで `安定/注意/要改善` 色分け表示する方式にした。
- Why: 運用者の初動はトップページから始まるため、ジョブ監視ページへ遷移しなくても危険ジョブを一目で判別できる必要がある。色分けで優先順位判断を短縮するため。

- Decision: トップのSLOカードは `要改善 -> 注意 -> 安定` の優先順で並べ、カードクリックで `failed_only=1` + `focus=<job>` 付きの `/app/operations/jobs` へ遷移する導線にした。`operations/jobs` 側は `focus` を受けてフォーカス中ジョブをバッジ表示する。
- Why: 危険ジョブを先頭で提示し、次アクション（詳細監視）へ1クリックで繋げることで、障害初動の迷いを減らしMTTR短縮に寄与するため。

- Decision: `/app/operations/jobs` は `focus` 指定時に、該当セクション（planner/review/caseify/workflow）へ飛べる案内パネルを上部表示し、対象セクションを `ring` で強調する方式にした（`id` アンカー付与）。
- Why: SLOカード経由で遷移した後に、ページ内で目的セクションを探す時間を減らし、トリアージ導線をさらに短縮するため。

- Decision: `/app/operations/jobs` は `focus` 指定時、非対象の主要セクション（planner/review/caseify/workflow）を `<details>` でデフォルト折りたたみ表示にした。必要時のみ展開し、対象セクションに視線を集中させる。
- Why: フォーカス遷移後に情報量が多いと再び探索コストが発生するため。非対象を簡略化して「今見るべき箇所」を明確にするため。

- Decision: `focus` 中の `planner/review/workflow` セクションでは、失敗行を先頭固定し、失敗行を淡い赤背景で強調、さらに「最新失敗」1行サマリーを見出し直下に表示する方式にした。
- Why: フォーカスしても成功行が先に並ぶと障害初動が遅れるため。最新失敗を即認識できるUIにして一次トリアージ時間を短縮するため。

- Decision: `focus` セクション内に即時実行ボタンを追加し、ページ遷移なしで `Planner実行 / Governance Review実行 / Workflow Tick実行 / 外部イベントAuto-Caseify実行` を開始できるようにした。実行は `ConfirmSubmitButton` で確認付き。
- Why: 失敗特定後に別ページへ移動して実行する導線は初動を遅らせるため。監視画面から直接復旧アクションを起動して MTTR を下げるため。

- Decision: `/app/operations/jobs` に「最後に押したアクション」固定カードを追加し、`OPS_JOB_MANUAL_RUN` イベントを基に最新手動実行（成功/失敗、実行ジョブ、メッセージ）を常時表示する方式にした。直近履歴（最大5件）も同カード内に展開可能とした。
- Why: 手動復旧を連続実行すると直前結果を見失いやすいため。ページ再読み込み後も最後の実行結果を保持し、オペレーターの状況把握を安定化させるため。

- Decision: 「最後に押したアクション」カードおよび直近履歴には、`job_name` と成否に応じた遷移先リンク（復旧先/関連ページ）を表示する仕様にした。失敗時は原則 `focus` 付き jobs や該当キューへ誘導する。
- Why: 実行結果を確認した後の次アクションを明示しないと、オペレーターが画面遷移先を迷いやすいため。復旧導線を固定カード内に内包して初動を短縮するため。

- Decision: 復旧先リンクには `ref_job` / `ref_ts` を付与し、`/app/operations/jobs` 側で参照元コンテキストを表示しつつ、該当時刻行をインディゴでハイライトする方式を追加した。
- Why: 復旧導線で往復した際に「どの実行結果を見ているか」が失われると判断ミスが起きるため。参照コンテキストをURLで保持して追跡性を高めるため。

- Decision: `ref_job` / `ref_ts` の参照コンテキスト表示と対象行ハイライトを `/app/events` と `/app/workflows/runs` にも拡張した。`workflow_tick` / `events_auto_caseify` では ref時刻一致がない場合でも最優先候補（failed run / high priority new event）をフォールバックで強調する。
- Why: 復旧先ページ側で参照対象を見失うと次アクションが遅れるため。監視画面外でも文脈を維持し、オペレーターの探索コストを下げるため。

- Decision: `ref_job` / `ref_ts` の参照コンテキスト表示と対象行ハイライトを `/app/cases` と `/app/chat/audit` にも拡張した。`events_auto_caseify` と `workflow_tick` の ref では時刻一致がない場合、各画面の復旧対象候補（ケース先頭/失敗コマンド）をフォールバック強調する。
- Why: operations/jobs の手動実行カードから遷移した後も「何の復旧文脈で来たか」を見失わないようにし、ページ間でのトリアージ時間を短縮するため。

- Decision: チャット実行で未対応 `intent_type` を例外で失敗扱いにせず、`skipped`（`skip_reason=unsupported_intent_type`）として安全に完了させるフォールバックを追加した。
- Why: 意図パーサーの拡張途中で未知intentが混入しても運用フロー全体を失敗にせず、ユーザーへ再指示を促しつつ監査ログを残すため。

- Decision: `/app/tasks/[id]` の「メール送信を実行」可否判定に、`同一idempotency_keyのsuccess/queued/running` と `task単位のrunning/queued` を反映し、サーバー側の `executeTaskDraftActionShared` のスキップ条件（既実行・実行中・キュー済み）とUI表示を一致させた。
- Why: 実行できない状態で実行ボタンが表示されるとオペレーター判断を誤らせるため。フロントの可否表示を実行ロジックと同一の意味に揃え、運用の予測可能性を上げるため。

- Decision: チャット実行失敗とワークフロー実行失敗のユーザー表示を `toUserActionableError` で正規化し、技術的エラー文をそのまま返さず「次に何をすべきか」が分かる文面に統一した。`chat_commands.result_json` には `error`（表示用）と `raw_error`（監査/デバッグ用）を分離記録する。
- Why: 実運用では失敗時の初動が最重要であり、エラー文が技術寄りだと復旧行動が遅れるため。表示文を行動指向に統一しつつ、監査用には生エラーを保持するため。

- Decision: チャットの曖昧解消メッセージ（task/case/proposal/approval）から `*_id` 表示を外し、候補提示を「表示名（タイトル）」ベースに統一した。再入力例も名称指定のみを案内する。
- Why: 会話UIで内部IDを露出すると利用者の認知負荷が上がるため。業務文脈の名称で完結できる誘導を優先し、入力負担を下げるため。

- Decision: チャット実行失敗時は `intent_type` ごとに復旧先ページ（approvals/tasks/workflows/planner/monitor/cases など）を自動付与し、システムメッセージに `次の確認先: /app/...` を表示する仕様にした。監査メタデータにも `recovery_path` を保存する。
- Why: 失敗理由だけでは次アクションが曖昧になりやすいため。失敗直後に最短で復旧画面へ誘導し、運用の停滞を減らすため。

- Decision: チャット実行失敗時の `recovery_path` を `chat_commands.result_json` と `ai_execution_logs.metadata_json` の両方に保存し、`/app/chat/audit` と `/app/executions` から「復旧先を開く」リンクを直接表示するようにした。
- Why: 失敗時の再現性ある復旧導線を監査画面と実行履歴画面の両方で保証し、オペレーターの復旧時間を短縮するため。

- Decision: 復旧リンクに `ref_from/ref_intent/ref_ts` を付与し、`/app/approvals`, `/app/tasks`, `/app/workflows/runs`, `/app/planner`, `/app/monitor`, `/app/cases` で参照コンテキストバナーを表示するようにした。
- Why: 失敗ログから復旧画面へ遷移した際に、どの失敗文脈で来たかを明示して判断ミスを減らすため。

- Decision: 参照コンテキスト遷移時の対象行ハイライトを `/app/approvals`, `/app/tasks`, `/app/planner`, `/app/monitor` に拡張した。`ref_ts` 一致を最優先し、未一致時は `ref_intent` ごとのフォールバック（先頭/失敗優先）で強調する。
- Why: 復旧先で対象を目視探索する時間を削減し、失敗起点のトリアージを一手で始められるようにするため。

- Decision: 復旧リンクには `#ref-target` アンカーを付与し、遷移先のハイライト対象行に `id=ref-target` を設定して自動スクロールさせる仕様にした。
- Why: 復旧先で対象行までのスクロール探索を省き、失敗起点の一次対応をさらに短縮するため。

- Decision: 復旧導線E2Eは安定性優先で `seed-recovery-context` テスト用APIを追加し、`ai_execution_logs` の失敗行と `planner_runs` を事前投入して `実行履歴 -> 復旧先リンク -> 参照コンテキスト表示 + #ref-targetハイライト` を検証する方式にした。
- Why: 実運用の失敗発生をテスト内で再現すると非決定的になりやすいため。最小シードで導線品質だけを確実に担保するため。

- Decision: `seed-recovery-context` に `includeChatAudit` フラグを追加し、必要時のみ `chat_sessions/messages/intents/commands` と `ai_execution_logs.metadata_json.command_id` を同時シードするようにした。これにより `chat audit -> 復旧先リンク` 導線も deterministic にE2E検証できる。
- Why: 既存の実行履歴E2E互換を保ちつつ、チャット監査側の復旧リンク品質も同じ粒度で担保するため。

- Decision: `/api/chat/audit/export` のフィルタを監査画面に合わせて拡張し、`status=declined/skipped` と `session_id` を正式サポートした。CSVメタにも `filter_session_id` を出力する。
- Why: 画面で見ている条件とエクスポート結果の不一致を減らし、監査データの再現性を高めるため。

- Decision: chat監査エクスポートの回帰防止として、Playwrightに `chat audit export respects session_id and status filters` を追加した。`seed-recovery-context` で chat監査データを作成し、`/api/chat/audit/export?format=json` の `meta` と `rows` がフィルタ条件に一致することを検証する。
- Why: 監査用途では「UI条件どおりに抽出されること」が重要であり、APIの小さな条件漏れをE2Eで早期検知するため。

- Decision: `seed-recovery-context` に `blockedByIncident` / `incidentSeverity` / `executionLogStatus` を追加し、`/api/executions/export` の `session_id + incident=blocked` 条件をPlaywrightで検証した（`executions export respects session_id and incident filters`）。
- Why: 実行監査CSVはインシデント停止行の抽出が重要で、運用時に最も参照される条件の回帰を自動テストで固定するため。

- Decision: `/app/executions` にも監査画面と同様の「条件リンクコピー」「条件付きエクスポート表示」「アクティブフィルタ要約」を追加した。URL共有は現在の絞り込み条件（window/from/to含む）をそのまま保持する。
- Why: 実行監査での引き継ぎや監査再現を、chat監査と同じ操作感で行えるようにしてオペレーターの認知負荷を下げるため。

- Decision: `CopyFilterLinkButton` を `/app/events` と `/app/operations/jobs` にも展開し、両ページで「条件付き表示/エクスポート」バッジとフィルタ要約を表示するようにした。`events` は status/provider/source/priority/from/to/q、`jobs` は failed_only/window/focus をURL化する。
- Why: 監視・運用ページ間でフィルタ共有体験を統一し、運用引き継ぎ時の再現コストを下げるため。

- Decision: 同じフィルタ共有UIを `/app/proposals` と `/app/monitor` にも追加した。`proposals` は status/policy_status/source/min_priority/decision_reason_prefix、`monitor` は window/monitor_run_id をリンク化し、条件付き表示バッジと要約を出す仕様にした。
- Why: 提案評価画面と監視画面でも条件共有・再現手順を統一し、運用チーム間の引き継ぎ時間を短縮するため。

- Decision: `/app/tasks` と `/app/approvals` にも `CopyFilterLinkButton` を追加し、条件付き表示バッジとフィルタ要約を表示するようにした。`tasks` は source/case_id、`approvals` は stale_only/high_risk_only/sort/window を共有URL化する。
- Why: コア運用画面でのフィルタ共有体験を完全に揃え、障害対応やレビュー引き継ぎ時の「同じ条件を再現する」手間を減らすため。

- Decision: `/app` トップの主要リンクで `window` 文脈の引き継ぎ漏れがあった `governance/recommendations` への導線2箇所を `withWindowParam(...)` に統一した。
- Why: ホームから遷移した際に期間コンテキストが失われると、監視・改善判断の再現性が落ちるため。

- Decision: `/app/chat/audit` のサーバーアクションフォーム（期限切れ整理、一括再実行確認、個別再実行確認）の `return_to` を固定 `/app/chat/audit` から `currentFilterPath` に変更した。
- Why: 監査フィルタ適用中の操作後に条件が失われると再調査コストが増えるため。操作後も同一条件へ戻すことでトリアージ継続性を高めるため。

- Decision: `/app/operations/jobs` の主要実行アクション（incident/caseify/workflow/alert/planner/review/guard/circuit解除）に `return_to` hidden を付与し、`actions.ts` 側で `return_to` を安全に解釈して成功/失敗メッセージ付きで元の `window/focus/failed_only` 条件へ戻すようにした。
- Why: ジョブ実行後にフォーカス文脈が失われると連続オペレーションが中断されるため。操作後も同一コンテキストを維持してMTTR短縮につなげるため。

- Decision: `lib/app/returnTo.ts` を追加し、`resolveSafeAppReturnTo` と `withMessageOnReturnTo` で `return_to` を `/app/` 配下に限定して扱う共通実装にした。`approvals/actions.ts` と `events/actions.ts` はこの共通関数を使って遷移先へ `ok/error` を付与する方式に統一した。
- Why: 各画面のアクション実装ごとにリダイレクトURL組み立てを重複させると、条件保持漏れや安全性の揺れが起きやすいため。共通化で再現性と保守性を上げるため。

- Decision: `/app/approvals` と `/app/events` のアクションフォームにも `return_to=currentFilterPath` を付与し、`stale_only/high_risk_only/sort/window` や `status/provider/source/priority/from/to/q` の文脈を操作後に維持するようにした。
- Why: 承認・イベント運用は同条件で連続操作するケースが多く、操作後にフィルタがリセットされると再トリアージコストが高いため。

- Decision: ESLint の Flat Config に Next.js 公式プラグイン（`@next/eslint-plugin-next`）を追加し、`recommended` + `core-web-vitals` ルールを標準適用した。
- Why: `next build` 時の「Next.js plugin 未検出」警告を解消し、CI/ローカルで同一の品質ゲートを維持するため。

- Decision: プロフィール/チャットのアバター表示は `<img>` から `next/image` に置換し、外部URL互換性を保つため `unoptimized` を付与した。
- Why: Next ESLint の `@next/next/no-img-element` へ準拠しつつ、現行の外部アバターURL仕様（ドメイン固定なし）を壊さないため。

- Decision: Playwright E2E はプレースホルダ文言や英語固定テキストへの依存を減らし、`name` 属性セレクタ・`href` セレクタ・日英両対応の状態ラベル正規表現で判定する方針に更新した。UI上で再実行ボタンが非表示になるケースは「非表示+実行済み文言」を成功条件として扱う。
- Why: 日本語UI改善や文言変更でE2Eが連鎖的に不安定化するのを防ぎ、機能の本質（状態遷移・イベント記録）を検証対象として維持するため。

- Decision: `org_autonomy_settings` に `enforce_initiator_approver_separation`（default: false）を追加し、ガバナンス設定UIから起票者≠承認者（SoD）を組織単位で有効化できるようにした。承認処理では有効時に「起票者が自身のタスクを承認」しようとした場合、承認更新前に拒否する。
- Why: 理想像で求める職務分掌（申請者/起票者と承認者の分離）を段階導入するため。既存運用を壊さない初期値（false）を維持しつつ、組織ごとに安全強化へ移行できるようにするため。

- Decision: `external_events` 系 migration（`20260306220000`, `20260306223000`）に「テーブル存在時のみ実行するガード」を追加し、`20260306235000_external_events_intake.sql` 側へ `priority/triage_note/triaged_at/linked_case_id` と関連 index を統合した。
- Why: 既存 migration の時系列差で `supabase db push` が失敗する環境があったため。順序を変えずに前方互換で修復し、新規環境でも同一スキーマに収束させるため。

- Decision: 承認拒否のうち職務分掌（SoD）で弾いたケースを `APPROVAL_BLOCKED` として `task_events` に記録し、`/app/approvals` に期間内ブロック件数（合計/SoD）と直近履歴を追加した。あわせて `blocked_only=1` フィルタで「ブロック発生タスク」へ絞り込めるようにした。
- Why: これまで SoD 拒否はユーザーエラー表示のみで運用監査に残らず、再発傾向や訓練対象の把握が難しかったため。Ledgerに残して可視化することで、統制運用の改善サイクルを回しやすくするため。

- Decision: ホーム `/app` と `/app/governance/recommendations` の指標に `APPROVAL_BLOCKED`（総数）と `sod_initiator_approver_conflict`（SoD違反）を追加し、改善提案にも「承認ブロック要因の是正」を自動生成するようにした。導線は `blocked_only=1` を付けて承認画面へ直行させる。
- Why: SoD違反を承認ページだけでなく全体運用のKPIとして扱い、日次監視→改善提案→現場対応のループを1クリックで回せるようにするため。

- Decision: `/app/approvals` に SoD違反の再発分析カード（起点メンバー上位5 / 発生経路上位5）を追加し、`APPROVAL_BLOCKED` の `reason_code` と `source` を運用改善指標として常時可視化した。
- Why: ブロック件数だけでは再発防止策（教育対象・導線改善）が決めにくいため。誰がどの経路で失敗しやすいかを同画面で把握し、改善アクションへ直接つなげるため。

- Decision: `buildGovernanceRecommendations` でも `APPROVAL_BLOCKED` 詳細を集計し、SoD提案文に「最多発生経路（source）」「最多起点メンバー（display_name）」を埋め込むようにした。
- Why: 提案カードを開いた時点で誰に何を改善すべきかが分かる形にし、分析画面へ遷移しなくても一次アクションを開始できるようにするため。

- Decision: 改善提案の説明文に、承認滞留は「最古滞留時間（hours）」、チャット失敗は「最多失敗意図（intent_type）」を埋め込むようにした。
- Why: 件数だけの提案は優先順位判断が難しいため。影響の深さ（滞留時間）と主因（失敗意図）を同時提示して、即時の対処判断を可能にするため。

- Decision: `/app/governance/recommendations` の各提案カードに「対処済みとして記録」アクションを追加し、`GOVERNANCE_RECOMMENDATION_APPLIED`（`action_kind=acknowledge_recommendation`）としてベースライン付きで監査履歴へ保存するようにした。
- Why: 実行自動化アクションが無い提案でも「確認して対処した」事実を残せるようにし、改善サイクルの追跡性（誰がいつ閉じたか）を高めるため。

- Decision: 改善提案ページに「未対応/対応済み/最新対処記録」の集計カードを追加し、提案ID単位で `acknowledge_recommendation` 履歴を突合してカードと各提案行へ対応状態を表示するようにした。
- Why: 提案数が増えると対応漏れを見落としやすくなるため。ページを開いた時点で残件と最新対応時刻を確認できるようにし、運用の継続性を上げるため。

- Decision: `acknowledge_recommendation` 記録時に `ack_meta`（`owner_user_id`, `due_at`, `due_days`）を保存し、改善提案一覧は「未対応を先頭」「次に優先度順」で並べる方式にした。対応済み行には担当と期限を表示する。
- Why: 対応済みの記録だけでは運用フォロー期限を管理しづらいため。軽量メタデータで担当/期限を残し、未対応案件の先頭表示で実行優先度を明確にするため。
