import Link from "next/link";
import { runGuardedAutoReminderNow } from "@/app/app/approvals/actions";
import { autoAssignStaleCasesToMe } from "@/app/app/cases/actions";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { runMonitorNow, saveMonitorRuntimeSettings } from "@/app/app/monitor/actions";
import { retryTopFailedWorkflowRuns } from "@/app/app/operations/exceptions/actions";
import { getOpsRuntimeSettings } from "@/lib/governance/opsRuntimeSettings";
import {
  buildMonitorNextActions,
  parseMonitorManualWorkflowFailures,
  parseMonitorRecoverySummary,
  parseMonitorSignalCounts
} from "@/lib/monitor/recommendations";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type MonitorPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
    window?: string;
    monitor_run_id?: string;
    ref_from?: string;
    ref_intent?: string;
    ref_ts?: string;
  }>;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function recommendationTone(level: "high" | "medium" | "low") {
  if (level === "high") return "border-rose-300 bg-rose-50 text-rose-900";
  if (level === "medium") return "border-amber-300 bg-amber-50 text-amber-900";
  return "border-sky-300 bg-sky-50 text-sky-900";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function resolveWindowHours(windowValue: string) {
  if (windowValue === "24h") return 24;
  if (windowValue === "30d") return 24 * 30;
  return 24 * 7;
}

function windowLabel(value: "24h" | "7d" | "30d") {
  if (value === "24h") return "24時間";
  if (value === "30d") return "30日";
  return "7日";
}

function runStatusLabel(status: string) {
  if (status === "completed") return "成功";
  if (status === "failed") return "失敗";
  if (status === "skipped") return "スキップ";
  if (status === "running") return "実行中";
  return status;
}

function monitorDecisionReasonLabel(reason: unknown) {
  if (reason === "signals_met") return "起動: シグナル条件を満たした";
  if (reason === "force_planner") return "起動: 強制実行";
  if (reason === "no_signals") return "スキップ: シグナルなし";
  if (reason === "incident_open") return "スキップ: インシデント停止中";
  if (reason === "below_score_threshold") return "スキップ: シグナルスコア不足";
  if (reason === "planner_cooldown") return "スキップ: クールダウン中";
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "（未設定）";
}

export default async function MonitorPage({ searchParams }: MonitorPageProps) {
  const sp = searchParams ? await searchParams : {};
  const refFrom = typeof sp.ref_from === "string" ? sp.ref_from : "";
  const refIntent = typeof sp.ref_intent === "string" ? sp.ref_intent : "";
  const refTs = typeof sp.ref_ts === "string" ? sp.ref_ts : "";
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const windowFilter = sp.window === "24h" || sp.window === "30d" ? sp.window : "7d";
  const monitorRunIdFilter =
    typeof sp.monitor_run_id === "string" && sp.monitor_run_id.trim().length > 0
      ? sp.monitor_run_id.trim()
      : "";
  const windowHours = resolveWindowHours(windowFilter);
  const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const runtimeSettings = await getOpsRuntimeSettings({ supabase, orgId });

  const [{ data, error }, { data: recoveryLogs, error: recoveryError }, { data: settingsLogs, error: settingsLogsError }] = await Promise.all([
    supabase
      .from("monitor_runs")
      .select("id, trigger_source, status, planner_invoked, planner_run_id, signal_counts_json, summary_json, created_at, finished_at")
      .eq("org_id", orgId)
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("ai_execution_logs")
      .select("execution_status, summary_text, metadata_json, created_at")
      .eq("org_id", orgId)
      .eq("source", "chat")
      .eq("intent_type", "monitor_recovery_run")
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("ai_execution_logs")
      .select("id, execution_status, summary_text, metadata_json, created_at, triggered_by_user_id")
      .eq("org_id", orgId)
      .eq("source", "planner")
      .eq("intent_type", "monitor_settings_update")
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(20)
  ]);

  if (error) {
    if (isMissingTableError(error.message, "monitor_runs")) {
      return (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          `monitor_runs` migration 未適用です。`supabase db push` を実行してください。
        </section>
      );
    }
    throw new Error(`Failed to load monitor runs: ${error.message}`);
  }
  if (recoveryError) {
    throw new Error(`Failed to load monitor recovery logs: ${recoveryError.message}`);
  }
  if (settingsLogsError) {
    throw new Error(`Failed to load monitor settings logs: ${settingsLogsError.message}`);
  }

  const allRows = (data ?? []) as Array<{
    id: string;
    trigger_source: string;
    status: string;
    planner_invoked: boolean;
    planner_run_id: string | null;
    signal_counts_json: unknown;
    summary_json: unknown;
    created_at: string;
    finished_at: string | null;
  }>;
  const rows = monitorRunIdFilter ? allRows.filter((row) => row.id === monitorRunIdFilter) : allRows;
  const completed = rows.filter((row) => row.status === "completed").length;
  const skipped = rows.filter((row) => row.status === "skipped").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const latestSummary = rows[0] ? asObject(rows[0].summary_json) : null;
  const latestBlockedByIncident = latestSummary?.blocked_by_incident === true;
  const latestIncidentSeverity =
    typeof latestSummary?.incident_severity === "string" ? latestSummary.incident_severity : null;
  const latestSignalCounts = rows[0] ? parseMonitorSignalCounts(rows[0].signal_counts_json) : null;
  const recoveryRows = (recoveryLogs ?? []) as Array<{
    execution_status: string;
    summary_text: string | null;
    metadata_json: unknown;
    created_at: string;
  }>;
  const monitorSettingsRows = (settingsLogs ?? []) as Array<{
    id: string;
    execution_status: string;
    summary_text: string | null;
    metadata_json: unknown;
    created_at: string;
    triggered_by_user_id: string | null;
  }>;
  const highlightedMonitorRunId = (() => {
    if (refTs) {
      const exact = rows.find((row) => String(row.created_at) === refTs);
      if (exact?.id) return String(exact.id);
    }
    if (refIntent === "monitor_recovery_run") {
      return rows[0]?.id ? String(rows[0].id) : null;
    }
    return null;
  })();
  const highlightedRecoveryIndex = (() => {
    if (refTs) {
      const idx = recoveryRows.findIndex((row) => String(row.created_at) === refTs);
      if (idx >= 0) return idx;
    }
    if (refIntent === "monitor_recovery_run") return 0;
    return -1;
  })();
  const highlightedSettingsLogId = (() => {
    if (refTs) {
      const exact = monitorSettingsRows.find((row) => String(row.created_at) === refTs);
      if (exact?.id) return String(exact.id);
    }
    if (refIntent === "monitor_settings_update") {
      return monitorSettingsRows[0]?.id ? String(monitorSettingsRows[0].id) : null;
    }
    return null;
  })();
  const settingsActorIds = Array.from(
    new Set(
      monitorSettingsRows
        .map((row) => row.triggered_by_user_id)
        .filter((value): value is string => Boolean(value))
    )
  );
  const settingsActorNameById = new Map<string, string>();
  if (settingsActorIds.length > 0) {
    const { data: actorProfiles } = await supabase
      .from("user_profiles")
      .select("user_id, display_name")
      .eq("org_id", orgId)
      .in("user_id", settingsActorIds);
    for (const row of actorProfiles ?? []) {
      const userId = row.user_id as string;
      const displayName = (row.display_name as string | null)?.trim() ?? "";
      if (userId && displayName) settingsActorNameById.set(userId, displayName);
    }
  }
  const recoveryDone = recoveryRows.filter((row) => row.execution_status === "done").length;
  const recoveryFailed = recoveryRows.filter((row) => row.execution_status === "failed").length;
  const latestFailedRecovery = recoveryRows.find((row) => row.execution_status === "failed") ?? null;
  const monitorManualFailures: Array<{
    workflowRunId: string;
    reasonSummary: string;
    createdAt: string;
  }> = [];
  const seenWorkflowRunIds = new Set<string>();
  for (const row of recoveryRows) {
    const failures = parseMonitorManualWorkflowFailures(row.metadata_json).filter((item) => item.reasonClass === "manual");
    for (const item of failures) {
      if (seenWorkflowRunIds.has(item.workflowRunId)) continue;
      seenWorkflowRunIds.add(item.workflowRunId);
      monitorManualFailures.push({
        workflowRunId: item.workflowRunId,
        reasonSummary: item.reasonSummary,
        createdAt: row.created_at
      });
    }
  }
  const topManualFailures = monitorManualFailures.slice(0, 3);
  const workflowRunIds = Array.from(new Set(topManualFailures.map((row) => row.workflowRunId)));
  const workflowRunTitleById = new Map<string, string>();
  if (workflowRunIds.length > 0) {
    const { data: workflowRuns } = await supabase
      .from("workflow_runs")
      .select("id, task_id")
      .eq("org_id", orgId)
      .in("id", workflowRunIds);

    const taskIds = Array.from(
      new Set((workflowRuns ?? []).map((row) => row.task_id as string).filter(Boolean))
    );
    const taskTitleById = new Map<string, string>();
    if (taskIds.length > 0) {
      const { data: tasks } = await supabase
        .from("tasks")
        .select("id, title")
        .eq("org_id", orgId)
        .in("id", taskIds);
      for (const row of tasks ?? []) {
        taskTitleById.set(row.id as string, row.title as string);
      }
    }
    for (const row of workflowRuns ?? []) {
      const taskId = row.task_id as string | null;
      const taskTitle = taskId ? taskTitleById.get(taskId) : null;
      workflowRunTitleById.set(
        row.id as string,
        taskTitle ? `${taskTitle} のworkflow失敗` : "ワークフロー失敗"
      );
    }
  }
  const recoveryRecommendations = latestSignalCounts
    ? buildMonitorNextActions({
        signalCounts: latestSignalCounts,
        recoverySummary: latestFailedRecovery ? parseMonitorRecoverySummary(latestFailedRecovery.metadata_json) : null
      })
    : [];
  const hasActiveFilters = windowFilter !== "7d" || Boolean(monitorRunIdFilter);
  const filterSummary = [
    windowFilter !== "7d" ? `集計期間=${windowLabel(windowFilter)}` : null,
    monitorRunIdFilter ? `monitor_run_id=${monitorRunIdFilter}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const currentFilterParams = new URLSearchParams();
  currentFilterParams.set("window", windowFilter);
  if (monitorRunIdFilter) currentFilterParams.set("monitor_run_id", monitorRunIdFilter);
  const currentFilterPath = `/app/monitor?${currentFilterParams.toString()}`;

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">監視ティック</h1>
        <p className="mt-2 text-sm text-slate-600">
          滞留案件・承認停滞・失敗イベントを監視し、必要時だけプランナーを起動します。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={runMonitorNow}>
            <input type="hidden" name="window" value={windowFilter} />
            <ConfirmSubmitButton
              label="今すぐ監視実行"
              pendingLabel="実行中..."
              confirmMessage="監視ティックを実行します。よろしいですか？"
              className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800"
            />
          </form>
          <form action={runMonitorNow}>
            <input type="hidden" name="window" value={windowFilter} />
            <input type="hidden" name="force_planner" value="1" />
            <ConfirmSubmitButton
              label="強制プランナー実行"
              pendingLabel="実行中..."
              confirmMessage="シグナル有無に関わらずプランナーを実行します。よろしいですか？"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            />
          </form>
          <Link href="/app/planner" className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
            プランナーへ
          </Link>
        </div>
        <StatusNotice ok={sp.ok} error={sp.error} className="mt-4" />
        {refFrom || refIntent || refTs ? (
          <p className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
            参照コンテキスト: {refFrom || "unknown"}
            {refIntent ? ` / ${refIntent}` : ""}
            {refTs ? ` / ${new Date(refTs).toLocaleString("ja-JP")}` : ""}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1">集計期間: {windowLabel(windowFilter)}</span>
          <form method="get" className="inline-flex items-center gap-2">
            <select name="window" defaultValue={windowFilter} className="rounded-md border border-slate-300 px-2 py-1">
              <option value="24h">24時間</option>
              <option value="7d">7日</option>
              <option value="30d">30日</option>
            </select>
            <button type="submit" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-50">
              期間適用
            </button>
          </form>
          <CopyFilterLinkButton path={currentFilterPath} />
          {hasActiveFilters ? (
            <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">条件付き表示</span>
          ) : null}
        </div>
        {hasActiveFilters ? <p className="mt-2 text-xs text-slate-600">{filterSummary}</p> : null}
        {latestBlockedByIncident ? (
          <p className="mt-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            現在の監視実行はインシデントモード中のため planner 起動を停止中です
            {latestIncidentSeverity ? `（severity=${latestIncidentSeverity}）` : ""}。
          </p>
        ) : null}
        {monitorRunIdFilter ? (
          <p className="mt-3 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            monitor_run_id で絞り込み中: {monitorRunIdFilter}
          </p>
        ) : null}
        <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-800">監視/提案 実行閾値</summary>
          <form action={saveMonitorRuntimeSettings} className="mt-3 grid gap-3 md:grid-cols-4">
            <input type="hidden" name="window" value={windowFilter} />
            <label className="text-xs text-slate-700">
              stale判定時間(h)
              <input
                type="number"
                name="monitor_stale_hours"
                min={1}
                max={168}
                defaultValue={runtimeSettings.monitorStaleHours}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-xs text-slate-700">
              planner最小スコア
              <input
                type="number"
                name="monitor_min_signal_score"
                min={1}
                max={999}
                defaultValue={runtimeSettings.monitorMinSignalScore}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-xs text-slate-700">
              plannerクールダウン(分)
              <input
                type="number"
                name="monitor_planner_cooldown_minutes"
                min={0}
                max={1440}
                defaultValue={runtimeSettings.monitorPlannerCooldownMinutes}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-xs text-slate-700">
              提案デデュープ時間(h)
              <input
                type="number"
                name="planner_proposal_dedupe_hours"
                min={1}
                max={336}
                defaultValue={runtimeSettings.plannerProposalDedupeHours}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
              />
            </label>
            <div className="md:col-span-4">
              <ConfirmSubmitButton
                label="閾値を保存"
                pendingLabel="保存中..."
                confirmMessage="監視/提案の実行閾値を更新します。実行しますか？"
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-100"
              />
            </div>
          </form>
        </details>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs text-emerald-700">成功</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{completed}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-700">スキップ</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{skipped}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-xs text-rose-700">失敗</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{failed}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">設定変更監査（{windowLabel(windowFilter)}）</h2>
          <Link
            href={`/app/executions?window=${windowFilter}&source=planner&intent=monitor_settings_update`}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            実行履歴で開く
          </Link>
        </div>
        {monitorSettingsRows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">直近{windowLabel(windowFilter)}の設定変更はありません。</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {monitorSettingsRows.slice(0, 10).map((row) => {
              const meta = asObject(row.metadata_json);
              const changedFields = asObject(meta?.changed_fields);
              const actorLabel = row.triggered_by_user_id
                ? settingsActorNameById.get(row.triggered_by_user_id) ?? "表示名未設定メンバー"
                : "システム";
              return (
                <li
                  key={row.id}
                  id={highlightedSettingsLogId !== null && row.id === highlightedSettingsLogId ? "ref-target" : undefined}
                  className={`rounded-lg border p-3 text-sm text-slate-700 ${
                    highlightedSettingsLogId !== null && row.id === highlightedSettingsLogId
                      ? "border-indigo-300 bg-indigo-50/50 ring-1 ring-indigo-200"
                      : "border-slate-200"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                      {runStatusLabel(row.execution_status)}
                    </span>
                    <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                      {actorLabel}
                    </span>
                    <span className="text-slate-500">{new Date(row.created_at).toLocaleString("ja-JP")}</span>
                  </div>
                  <p className="mt-1">{row.summary_text ?? "監視設定を更新"}</p>
                  {changedFields ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-slate-600">変更差分</summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                        {toRedactedJson(changedFields)}
                      </pre>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">チャット回収実行履歴</h2>
        <p className="mt-2 text-sm text-slate-600">
          `@AI 監視回収を実行` の結果を表示します。承認催促・再試行・割当の処理件数を監査できます。
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs text-emerald-700">成功</p>
            <p className="mt-1 text-xl font-semibold text-emerald-900">{recoveryDone}</p>
          </div>
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs text-rose-700">失敗</p>
            <p className="mt-1 text-xl font-semibold text-rose-900">{recoveryFailed}</p>
          </div>
        </div>
        {recoveryRows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">直近{windowLabel(windowFilter)}のチャット回収実行履歴はまだありません。</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {recoveryRows.slice(0, 10).map((row, index) => {
              const parsed = parseMonitorRecoverySummary(row.metadata_json);
              return (
                <li
                  key={`${row.created_at}-${index}`}
                  id={highlightedRecoveryIndex >= 0 && index === highlightedRecoveryIndex ? "ref-target" : undefined}
                  className={`rounded-lg border p-3 text-sm text-slate-700 ${
                    highlightedRecoveryIndex >= 0 && index === highlightedRecoveryIndex
                      ? "border-indigo-300 bg-indigo-50/50 ring-1 ring-indigo-200"
                      : "border-slate-200"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{runStatusLabel(row.execution_status)}</span>
                    <span className="text-slate-500">{new Date(row.created_at).toLocaleString("ja-JP")}</span>
                  </div>
                  <p className="mt-1 text-slate-800">{row.summary_text ?? "監視回収を実行しました"}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    承認催促 {parsed.reminderSent}/{parsed.reminderTarget} | workflow再試行 {parsed.workflowSuccess}/{parsed.workflowTarget} (failed:
                    {parsed.workflowFailed}, extra_recovered:{parsed.workflowRecoveredExtra}) | 案件割当 {parsed.caseAssigned}/{parsed.caseTarget}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    例外ケース自動化: created={parsed.exceptionCasesCreated} / updated={parsed.exceptionCasesUpdated}
                  </p>
                  {parsed.workflowFailed > 0 ? (
                    <p className="mt-1 text-xs text-slate-600">
                      失敗分類: retryable={parsed.workflowFailedRetryable} / manual={parsed.workflowFailedManual}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">即時回収アクション</h2>
        <p className="mt-2 text-sm text-slate-600">
          詰まりが検知された時に、承認催促・再試行・担当割当をワンクリックで実行します。
        </p>
        {latestSignalCounts ? (
          <p className="mt-2 text-xs text-slate-500">
            最新シグナル: approvals={latestSignalCounts.stale_pending_approvals} / failed_actions=
            {latestSignalCounts.recent_action_failures} / stale_cases={latestSignalCounts.stale_open_cases}
          </p>
        ) : null}
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <form action={runGuardedAutoReminderNow} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <input type="hidden" name="window" value={windowFilter} />
            <input type="hidden" name="min_stale" value="1" />
            <ConfirmSubmitButton
              label="承認催促を実行"
              pendingLabel="実行中..."
              confirmMessage="SLA超過の承認待ちへリマインド送信を実行します。よろしいですか？"
              className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm text-amber-800 hover:bg-amber-100"
            />
          </form>
          <form action={retryTopFailedWorkflowRuns} className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <input type="hidden" name="limit" value="3" />
            <ConfirmSubmitButton
              label="失敗WFを再試行"
              pendingLabel="実行中..."
              confirmMessage="直近の失敗workflow runを最大3件再試行します。よろしいですか？"
              className="w-full rounded-md border border-rose-300 bg-white px-3 py-2 text-sm text-rose-800 hover:bg-rose-100"
            />
          </form>
          <form action={autoAssignStaleCasesToMe} className="rounded-lg border border-sky-200 bg-sky-50 p-3">
            <input type="hidden" name="limit" value="5" />
            <input type="hidden" name="return_to" value={`/app/monitor?window=${windowFilter}`} />
            <ConfirmSubmitButton
              label="滞留案件を自分に割当"
              pendingLabel="実行中..."
              confirmMessage="未割当の滞留案件を最大5件、あなたへ自動割当します。よろしいですか？"
              className="w-full rounded-md border border-sky-300 bg-white px-3 py-2 text-sm text-sky-800 hover:bg-sky-100"
            />
          </form>
        </div>
      </section>

      {recoveryRecommendations.length > 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">次の推奨アクション</h2>
          <p className="mt-2 text-sm text-slate-600">直近の監視・回収結果をもとに、優先対応順で提案します。</p>
          <ul className="mt-3 space-y-2">
            {recoveryRecommendations.map((tip) => (
              <li key={tip.key} className={`rounded-lg border p-3 text-sm ${recommendationTone(tip.level)}`}>
                <p>{tip.text}</p>
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-current/80">根拠シグナル</summary>
                  <ul className="mt-1 list-disc pl-5">
                    {tip.evidence.map((item) => (
                      <li key={`${tip.key}-${item}`}>{item}</li>
                    ))}
                  </ul>
                </details>
                <Link href={tip.href} className="mt-2 inline-flex rounded-md border border-current/30 bg-white/70 px-2 py-1 text-xs underline">
                  {tip.cta}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {topManualFailures.length > 0 ? (
        <section className="rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">手動対応が必要な失敗（優先3件）</h2>
            <Link href="/app/operations/exceptions" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">
              例外キューへ
            </Link>
          </div>
          <ul className="mt-3 space-y-2">
            {topManualFailures.map((row) => (
              <li key={row.workflowRunId} className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/app/workflows/runs/${row.workflowRunId}`} className="font-medium text-rose-900 underline">
                    {workflowRunTitleById.get(row.workflowRunId) ?? "ワークフロー失敗"}
                  </Link>
                  <span className="text-xs text-rose-700">{new Date(row.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-xs text-rose-800">{row.reasonSummary}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">最近の監視実行（{windowLabel(windowFilter)}）</h2>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">直近{windowLabel(windowFilter)}の監視実行履歴はまだありません。</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {rows.map((row) => {
              const summary = asObject(row.summary_json);
              const blockedByIncident = summary?.blocked_by_incident === true;
              const incidentSeverity =
                typeof summary?.incident_severity === "string" ? summary.incident_severity : null;
              const isRef = highlightedMonitorRunId !== null && String(row.id) === highlightedMonitorRunId;
              return (
                <li
                  key={row.id}
                  id={isRef ? "ref-target" : undefined}
                  className={`rounded-lg border p-3 text-sm text-slate-700 ${
                    isRef ? "border-indigo-300 bg-indigo-50/50 ring-1 ring-indigo-200" : "border-slate-200"
                  }`}
                >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{runStatusLabel(row.status)}</span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{row.trigger_source}</span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                    planner: {row.planner_invoked ? "あり" : "なし"}
                  </span>
                  {blockedByIncident ? (
                    <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-rose-800">
                      incident停止{incidentSeverity ? `:${incidentSeverity}` : ""}
                    </span>
                  ) : null}
                  <span className="text-slate-500">{new Date(row.created_at).toLocaleString("ja-JP")}</span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  終了: {row.finished_at ? new Date(row.finished_at).toLocaleString("ja-JP") : "実行中"}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  判定: {monitorDecisionReasonLabel(summary?.decision_reason ?? summary?.reason)}
                  {typeof summary?.signal_score === "number" ? ` | score=${summary.signal_score}` : ""}
                  {typeof summary?.min_required_score === "number" ? ` / min=${summary.min_required_score}` : ""}
                </p>
                {typeof summary?.cooldown_until === "string" && summary.cooldown_until.length > 0 ? (
                  <p className="mt-1 text-xs text-slate-500">
                    cooldown_until: {new Date(summary.cooldown_until).toLocaleString("ja-JP")}
                  </p>
                ) : null}
                {row.planner_run_id ? (
                  <p className="mt-1 text-xs text-slate-600">
                    planner run:{" "}
                    <Link href={`/app/planner?planner_run_id=${row.planner_run_id}`} className="underline">
                      実行履歴で確認
                    </Link>
                  </p>
                ) : null}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-600">signal_counts / summary</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                    {toRedactedJson({
                      signal_counts: row.signal_counts_json,
                      summary: row.summary_json
                    })}
                  </pre>
                </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
