import {
  clearJobCircuitNow,
  resendOpsAlertNow,
  runAutoIncidentCheckNow,
  runWorkflowTickNow
} from "@/app/app/operations/jobs/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type JobsPageProps = {
  searchParams?: Promise<{ failed_only?: string; ok?: string; error?: string }>;
};

type PlannerRunRow = {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  summary_json: unknown;
};

type ReviewEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type AlertEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type IncidentEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type RetryEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type CircuitRow = {
  id: string;
  job_name: string;
  consecutive_failures: number;
  paused_until: string | null;
  updated_at: string;
};

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isMissingTable(message: string, table: string) {
  return message.includes(`relation "${table}" does not exist`) || message.includes(`public.${table}`);
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function formatElapsedFromNow(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function consecutiveFailuresByStatus(rows: Array<{ status: string }>) {
  let count = 0;
  for (const row of rows) {
    if (row.status === "failed") {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function consecutiveFailuresByEventType(rows: Array<{ event_type: string }>) {
  let count = 0;
  for (const row of rows) {
    if (row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED") {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

export default async function OperationsJobsPage({ searchParams }: JobsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const failedOnly = String(sp.failed_only ?? "") === "1";

  const [plannerRunsRes, reviewEventsRes, alertEventsRes, incidentEventsRes, retryEventsRes, circuitRes] =
    await Promise.all([
    supabase
      .from("planner_runs")
      .select("id, status, created_at, finished_at, summary_json")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("task_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["GOVERNANCE_RECOMMENDATIONS_REVIEWED", "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"])
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("task_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", [
        "OPS_ALERT_POSTED",
        "OPS_ALERT_FAILED",
        "OPS_JOB_CIRCUIT_ALERT_POSTED",
        "OPS_JOB_CIRCUIT_ALERT_FAILED"
      ])
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("incident_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["INCIDENT_AUTO_DECLARED"])
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("task_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", [
        "OPS_JOB_RETRY_SCHEDULED",
        "OPS_JOB_RETRY_RECOVERED",
        "OPS_JOB_RETRY_EXHAUSTED",
        "OPS_JOB_SKIPPED_CIRCUIT_OPEN",
        "OPS_JOB_CIRCUIT_OPENED",
        "OPS_JOB_CIRCUIT_CLOSED",
        "OPS_JOB_CIRCUIT_MANUALLY_CLEARED"
      ])
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("org_job_circuit_breakers")
      .select("id, job_name, consecutive_failures, paused_until, updated_at")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(30)
    ]);

  if (plannerRunsRes.error && !isMissingTable(plannerRunsRes.error.message, "planner_runs")) {
    throw new Error(`Failed to load planner runs: ${plannerRunsRes.error.message}`);
  }
  if (reviewEventsRes.error) {
    throw new Error(`Failed to load governance review events: ${reviewEventsRes.error.message}`);
  }
  if (alertEventsRes.error) {
    throw new Error(`Failed to load ops alert events: ${alertEventsRes.error.message}`);
  }
  if (incidentEventsRes.error && !isMissingTable(incidentEventsRes.error.message, "incident_events")) {
    throw new Error(`Failed to load incident events: ${incidentEventsRes.error.message}`);
  }
  if (retryEventsRes.error) {
    throw new Error(`Failed to load retry events: ${retryEventsRes.error.message}`);
  }
  if (circuitRes.error && !isMissingTable(circuitRes.error.message, "org_job_circuit_breakers")) {
    throw new Error(`Failed to load job circuit state: ${circuitRes.error.message}`);
  }

  const plannerRuns = (plannerRunsRes.data ?? []) as PlannerRunRow[];
  const reviewEvents = (reviewEventsRes.data ?? []) as ReviewEventRow[];
  const alertEvents = (alertEventsRes.data ?? []) as AlertEventRow[];
  const incidentEvents = (incidentEventsRes.data ?? []) as IncidentEventRow[];
  const retryEvents = (retryEventsRes.data ?? []) as RetryEventRow[];
  const circuits = (circuitRes.data ?? []) as CircuitRow[];
  const filteredPlannerRuns = failedOnly ? plannerRuns.filter((row) => row.status === "failed") : plannerRuns;
  const filteredReviewEvents = failedOnly
    ? reviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED")
    : reviewEvents;
  const filteredAlertEvents = failedOnly
    ? alertEvents.filter((row) => row.event_type === "OPS_ALERT_FAILED" || row.event_type === "OPS_JOB_CIRCUIT_ALERT_FAILED")
    : alertEvents;

  const plannerCompleted = plannerRuns.filter((row) => row.status === "completed").length;
  const plannerFailed = plannerRuns.filter((row) => row.status === "failed").length;
  const reviewSuccess = reviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEWED").length;
  const reviewFailed = reviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED").length;
  const alertPosted = alertEvents.filter((row) => row.event_type === "OPS_ALERT_POSTED").length;
  const alertFailed = alertEvents.filter((row) => row.event_type === "OPS_ALERT_FAILED").length;
  const circuitAlertPosted = alertEvents.filter((row) => row.event_type === "OPS_JOB_CIRCUIT_ALERT_POSTED").length;
  const circuitAlertFailed = alertEvents.filter((row) => row.event_type === "OPS_JOB_CIRCUIT_ALERT_FAILED").length;
  const manualResendCount = alertEvents.filter((row) => {
    if (row.event_type !== "OPS_ALERT_POSTED") return false;
    const payload = asObject(row.payload_json);
    return payload?.source === "manual";
  }).length;
  const autoIncidentCount = incidentEvents.length;
  const retryScheduledCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_RETRY_SCHEDULED").length;
  const retryRecoveredCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_RETRY_RECOVERED").length;
  const retryExhaustedCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_RETRY_EXHAUSTED").length;
  const retrySkippedCircuitCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_SKIPPED_CIRCUIT_OPEN").length;
  const circuitOpenCount = circuits.filter((row) => {
    if (!row.paused_until) return false;
    const until = new Date(row.paused_until).getTime();
    return Number.isFinite(until) && until > Date.now();
  }).length;
  const latestPlannerFailure = plannerRuns.find((row) => row.status === "failed") ?? null;
  const latestReviewFailure =
    reviewEvents.find((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED") ?? null;
  const latestAlertFailure = alertEvents.find((row) => row.event_type === "OPS_ALERT_FAILED") ?? null;
  const plannerConsecutiveFailures = consecutiveFailuresByStatus(plannerRuns);
  const reviewConsecutiveFailures = consecutiveFailuresByEventType(reviewEvents);

  const barItems = [
    { key: "planner_completed", label: "planner_ok", value: plannerCompleted, color: "bg-emerald-500" },
    { key: "planner_failed", label: "planner_failed", value: plannerFailed, color: "bg-rose-500" },
    { key: "review_ok", label: "review_ok", value: reviewSuccess, color: "bg-sky-500" },
    { key: "review_failed", label: "review_failed", value: reviewFailed, color: "bg-amber-500" }
  ];
  const maxBar = Math.max(1, ...barItems.map((item) => item.value));

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-cyan-900 p-6 text-white shadow-lg">
        <p className="text-xs uppercase tracking-[0.18em] text-cyan-200">Ops Monitor</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">運用ジョブ履歴</h1>
        <p className="mt-2 text-sm text-slate-200">
          定期実行ジョブ（planner / governance recommendations review）の状態を確認できます。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={runAutoIncidentCheckNow}>
            <button
              type="submit"
              className="rounded-md border border-white/30 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
            >
              自動インシデント判定
            </button>
          </form>
          <form action={runWorkflowTickNow}>
            <button
              type="submit"
              className="rounded-md border border-white/30 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
            >
              Workflow Tick実行
            </button>
          </form>
          <form action={resendOpsAlertNow}>
            <button
              type="submit"
              className="rounded-md border border-white/30 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
            >
              Opsアラートを手動再送
            </button>
          </form>
        </div>
      </div>

      {sp.ok ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {sp.ok}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {sp.error}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-8">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <p className="text-xs text-emerald-700">planner completed</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{plannerCompleted}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">planner failed</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{plannerFailed}</p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-xs text-sky-700">review success</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{reviewSuccess}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <p className="text-xs text-amber-700">review failed</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{reviewFailed}</p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-xs text-sky-700">ops alert posted</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{alertPosted}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">ops alert failed</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{alertFailed}</p>
        </div>
        <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 shadow-sm">
          <p className="text-xs text-cyan-700">circuit alert posted</p>
          <p className="mt-1 text-2xl font-semibold text-cyan-900">{circuitAlertPosted}</p>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm">
          <p className="text-xs text-red-700">circuit alert failed</p>
          <p className="mt-1 text-2xl font-semibold text-red-900">{circuitAlertFailed}</p>
        </div>
        <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 shadow-sm">
          <p className="text-xs text-violet-700">manual resend (30)</p>
          <p className="mt-1 text-2xl font-semibold text-violet-900">{manualResendCount}</p>
        </div>
        <div className="rounded-xl border border-fuchsia-200 bg-fuchsia-50 p-4 shadow-sm">
          <p className="text-xs text-fuchsia-700">auto incidents (30)</p>
          <p className="mt-1 text-2xl font-semibold text-fuchsia-900">{autoIncidentCount}</p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
          <p className="text-xs text-indigo-700">retry scheduled</p>
          <p className="mt-1 text-2xl font-semibold text-indigo-900">{retryScheduledCount}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <p className="text-xs text-emerald-700">retry recovered</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{retryRecoveredCount}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">retry exhausted</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{retryExhaustedCount}</p>
        </div>
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 shadow-sm">
          <p className="text-xs text-orange-700">circuit open</p>
          <p className="mt-1 text-2xl font-semibold text-orange-900">{circuitOpenCount}</p>
        </div>
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4 shadow-sm">
          <p className="text-xs text-yellow-700">skipped by circuit</p>
          <p className="mt-1 text-2xl font-semibold text-yellow-900">{retrySkippedCircuitCount}</p>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">失敗ヘルス指標</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs text-rose-700">planner: 直近失敗からの経過</p>
            <p className="mt-1 text-lg font-semibold text-rose-900">
              {latestPlannerFailure ? formatElapsedFromNow(latestPlannerFailure.created_at) : "失敗なし"}
            </p>
            <p className="mt-1 text-xs text-rose-700">連続失敗: {plannerConsecutiveFailures}</p>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs text-amber-700">review: 直近失敗からの経過</p>
            <p className="mt-1 text-lg font-semibold text-amber-900">
              {latestReviewFailure ? formatElapsedFromNow(latestReviewFailure.created_at) : "失敗なし"}
            </p>
            <p className="mt-1 text-xs text-amber-700">連続失敗: {reviewConsecutiveFailures}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          ops alert最終失敗: {latestAlertFailure ? formatElapsedFromNow(latestAlertFailure.created_at) : "失敗なし"}
        </p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">ジョブ結果分布</h2>
          <span className="text-xs text-slate-500">0件は棒を表示しません</span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {barItems.map((item) => {
            const heightPct = item.value > 0 ? Math.max(12, Math.round((item.value / maxBar) * 100)) : 0;
            return (
              <div key={item.key} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="flex h-36 items-end justify-center rounded-md bg-white px-2">
                  {item.value > 0 ? <div className={`w-10 rounded-t-md ${item.color}`} style={{ height: `${heightPct}%` }} /> : null}
                </div>
                <p className="mt-2 text-center font-mono text-[11px] text-slate-600">{item.label}</p>
                <p className="text-center text-sm font-semibold text-slate-900">{item.value}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <form method="get" className="mb-4 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="failed_only" value="1" defaultChecked={failedOnly} className="h-4 w-4 rounded border-slate-300" />
            失敗のみ表示
          </label>
          <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            適用
          </button>
        </form>
        <h2 className="text-base font-semibold text-slate-900">Planner Runs（最新30件）</h2>
        {filteredPlannerRuns.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {filteredPlannerRuns.map((run) => (
              <li key={run.id} className="rounded-md border border-slate-200 p-3 text-sm">
                <p className="font-mono text-xs text-slate-500">{run.id}</p>
                <p className="mt-1 text-slate-800">
                  status:{" "}
                  <span className={run.status === "failed" ? "font-semibold text-rose-700" : "font-semibold text-emerald-700"}>
                    {run.status}
                  </span>
                </p>
                <p className="text-xs text-slate-600">
                  started: {new Date(run.created_at).toLocaleString()}
                  {run.finished_at ? ` / finished: ${new Date(run.finished_at).toLocaleString()}` : ""}
                </p>
                {run.status === "failed" ? (
                  <details className="mt-2 rounded-md border border-rose-200 bg-rose-50 p-2">
                    <summary className="cursor-pointer text-xs font-medium text-rose-700">失敗詳細(JSON)</summary>
                    <pre className="mt-2 overflow-x-auto text-xs text-rose-800">{prettyJson(run.summary_json)}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            {failedOnly ? "失敗した planner run はありません。" : "planner run 履歴はまだありません。"}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">ジョブサーキット状態</h2>
          <form action={clearJobCircuitNow} className="flex items-center gap-2">
            <input
              type="text"
              name="reason"
              placeholder="解除理由（監査用）"
              className="w-48 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700"
            />
            <button
              type="submit"
              className="rounded-md border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
            >
              全サーキット解除
            </button>
          </form>
        </div>
        {circuits.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">サーキット状態はまだありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2">job_name</th>
                  <th className="px-2 py-2">consecutive_failures</th>
                  <th className="px-2 py-2">paused_until</th>
                  <th className="px-2 py-2">updated_at</th>
                  <th className="px-2 py-2 text-right">actions</th>
                </tr>
              </thead>
              <tbody>
                {circuits.map((row) => {
                  const isOpen =
                    row.paused_until && Number.isFinite(new Date(row.paused_until).getTime())
                      ? new Date(row.paused_until).getTime() > Date.now()
                      : false;
                  return (
                    <tr key={row.id} className="border-b border-slate-100 text-slate-700">
                      <td className="px-2 py-2 font-mono text-xs">{row.job_name}</td>
                      <td className="px-2 py-2">{row.consecutive_failures}</td>
                      <td className={`px-2 py-2 ${isOpen ? "font-semibold text-orange-700" : "text-slate-500"}`}>
                        {row.paused_until ? new Date(row.paused_until).toLocaleString("ja-JP") : "-"}
                      </td>
                      <td className="px-2 py-2 text-slate-500">{new Date(row.updated_at).toLocaleString("ja-JP")}</td>
                      <td className="px-2 py-2 text-right">
                        <form action={clearJobCircuitNow} className="flex items-center justify-end gap-2">
                          <input type="hidden" name="job_name" value={row.job_name} />
                          <input
                            type="text"
                            name="reason"
                            placeholder="理由"
                            className="w-28 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                          />
                          <button
                            type="submit"
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                          >
                            このjobを解除
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">自動リトライ監査イベント</h2>
        {retryEvents.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">リトライイベントはまだありません。</p>
        ) : (
          <div className="mt-3 space-y-3">
            {retryEvents.slice(0, 12).map((row) => (
              <article key={row.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-slate-800">{row.event_type}</p>
                  <time className="text-xs text-slate-500">{new Date(row.created_at).toLocaleString("ja-JP")}</time>
                </div>
                {row.event_type === "OPS_JOB_CIRCUIT_MANUALLY_CLEARED" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                      手動解除
                    </span>
                    <span className="text-xs text-slate-700">
                      理由:{" "}
                      <span className="font-medium">
                        {(() => {
                          const payload = asObject(row.payload_json);
                          return typeof payload?.reason === "string" && payload.reason.trim()
                            ? payload.reason
                            : "manual_clear";
                        })()}
                      </span>
                    </span>
                  </div>
                ) : null}
                <pre className="mt-2 overflow-x-auto rounded-md bg-white p-2 text-xs text-slate-700">
                  {prettyJson(row.payload_json)}
                </pre>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Governance Review Events（最新30件）</h2>
        {filteredReviewEvents.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {filteredReviewEvents.map((event) => {
              const payload = asObject(event.payload_json);
              const error = typeof payload?.error === "string" ? payload.error : null;
              const recommendationCount =
                typeof payload?.recommendation_count === "number" ? payload.recommendation_count : null;
              return (
                <li key={event.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="font-mono text-xs text-slate-500">{event.id}</p>
                  <p className="mt-1">
                    event:{" "}
                    <span
                      className={
                        event.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"
                          ? "font-semibold text-rose-700"
                          : "font-semibold text-sky-700"
                      }
                    >
                      {event.event_type}
                    </span>
                  </p>
                  <p className="text-xs text-slate-600">at: {new Date(event.created_at).toLocaleString()}</p>
                  {recommendationCount !== null ? (
                    <p className="text-xs text-slate-600">recommendation_count: {recommendationCount}</p>
                  ) : null}
                  {error ? <p className="mt-1 text-xs text-rose-700">error: {error}</p> : null}
                  <details className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                    <summary className="cursor-pointer text-xs font-medium text-slate-700">payload JSON</summary>
                    <pre className="mt-2 overflow-x-auto text-xs text-slate-700">{prettyJson(event.payload_json)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            {failedOnly ? "失敗した governance review はありません。" : "governance review 履歴はまだありません。"}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Ops Alert Events（最新30件）</h2>
        {filteredAlertEvents.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {filteredAlertEvents.map((event) => {
              const payload = asObject(event.payload_json);
              const error = typeof payload?.error === "string" ? payload.error : null;
              const threshold = typeof payload?.threshold === "number" ? payload.threshold : null;
              const alertKey =
                typeof payload?.alert_key === "string" && payload.alert_key.length > 0
                  ? payload.alert_key
                  : null;
              const health = asObject(payload?.health);
              const slackPermalink =
                typeof payload?.slack_permalink === "string" && payload.slack_permalink.length > 0
                  ? payload.slack_permalink
                  : null;
              const channelId =
                typeof payload?.channel_id === "string" && payload.channel_id.length > 0
                  ? payload.channel_id
                  : null;
              return (
                <li key={event.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="font-mono text-xs text-slate-500">{event.id}</p>
                  <p className="mt-1">
                    event:{" "}
                    <span
                      className={
                        event.event_type === "OPS_ALERT_FAILED"
                          ? "font-semibold text-rose-700"
                          : "font-semibold text-sky-700"
                      }
                    >
                      {event.event_type}
                    </span>
                  </p>
                  <p className="text-xs text-slate-600">at: {new Date(event.created_at).toLocaleString()}</p>
                  {threshold !== null ? <p className="text-xs text-slate-600">threshold: {threshold}</p> : null}
                  {alertKey ? <p className="text-xs text-slate-600">alert_key: <span className="font-mono">{alertKey}</span></p> : null}
                  {health ? (
                    <p className="text-xs text-slate-600">
                      planner_failures={String(health.plannerConsecutiveFailures ?? "-")} / review_failures=
                      {String(health.reviewConsecutiveFailures ?? "-")}
                    </p>
                  ) : null}
                  {slackPermalink ? (
                    <a
                      href={slackPermalink}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex text-xs font-medium text-sky-700 underline"
                    >
                      Slackメッセージを開く
                    </a>
                  ) : channelId ? (
                    <a
                      href={`https://slack.com/app_redirect?channel=${encodeURIComponent(channelId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex text-xs font-medium text-sky-700 underline"
                    >
                      Slackチャンネルを開く
                    </a>
                  ) : null}
                  {error ? <p className="mt-1 text-xs text-rose-700">error: {error}</p> : null}
                  <details className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                    <summary className="cursor-pointer text-xs font-medium text-slate-700">payload JSON</summary>
                    <pre className="mt-2 overflow-x-auto text-xs text-slate-700">{prettyJson(event.payload_json)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            {failedOnly ? "失敗した ops alert はありません。" : "ops alert 履歴はまだありません。"}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Auto Incident Events（最新30件）</h2>
        {incidentEvents.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {incidentEvents.map((event) => {
              const payload = asObject(event.payload_json);
              const trigger = typeof payload?.trigger === "string" ? payload.trigger : null;
              const metrics = asObject(payload?.metrics);
              return (
                <li key={event.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="font-mono text-xs text-slate-500">{event.id}</p>
                  <p className="mt-1">
                    event: <span className="font-semibold text-fuchsia-700">{event.event_type}</span>
                  </p>
                  <p className="text-xs text-slate-600">at: {new Date(event.created_at).toLocaleString()}</p>
                  {trigger ? <p className="text-xs text-slate-700">trigger: {trigger}</p> : null}
                  {metrics ? (
                    <p className="text-xs text-slate-600">
                      planner={String(metrics.plannerConsecutiveFailed ?? "-")} / review=
                      {String(metrics.reviewConsecutiveFailed ?? "-")} / action_failed=
                      {String(metrics.actionFailedCount ?? "-")}
                    </p>
                  ) : null}
                  <details className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                    <summary className="cursor-pointer text-xs font-medium text-slate-700">payload JSON</summary>
                    <pre className="mt-2 overflow-x-auto text-xs text-slate-700">{prettyJson(event.payload_json)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">auto incident 履歴はまだありません。</p>
        )}
      </section>
    </section>
  );
}
