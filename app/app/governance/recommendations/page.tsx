import Link from "next/link";
import { applyRecommendationAction, runRecommendationsReviewNow } from "@/app/app/governance/recommendations/actions";
import { buildGovernanceRecommendations } from "@/lib/governance/recommendations";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function priorityLabel(priority: "critical" | "high" | "medium" | "low") {
  if (priority === "critical") return "critical";
  if (priority === "high") return "high";
  if (priority === "medium") return "medium";
  return "low";
}

function priorityClasses(priority: "critical" | "high" | "medium" | "low") {
  if (priority === "critical") {
    return "border-rose-300 bg-rose-50 text-rose-800";
  }
  if (priority === "high") {
    return "border-amber-300 bg-amber-50 text-amber-800";
  }
  if (priority === "medium") {
    return "border-sky-300 bg-sky-50 text-sky-800";
  }
  return "border-emerald-300 bg-emerald-50 text-emerald-800";
}

function barColor(priority: "critical" | "high" | "medium" | "low") {
  if (priority === "critical") return "bg-rose-500";
  if (priority === "high") return "bg-amber-500";
  if (priority === "medium") return "bg-sky-500";
  return "bg-emerald-500";
}

type RecommendationsPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
    retry_action_kind?: string;
    retry_recommendation_id?: string;
    history_action_kind?: string;
    history_result?: string;
  }>;
};

type RecommendationEventRow = {
  id: string;
  created_at: string;
  event_type: string;
  actor_id: string | null;
  actor_type: string | null;
  payload_json: unknown;
};

type ReviewEventRow = {
  id: string;
  created_at: string;
  payload_json: unknown;
};

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function deltaLabel(delta: number) {
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

function impactBadge(args: { improved: number; worsened: number }) {
  if (args.improved > 0 && args.worsened === 0) {
    return { label: "improved", className: "bg-emerald-100 text-emerald-700" };
  }
  if (args.worsened > 0 && args.improved === 0) {
    return { label: "worsened", className: "bg-rose-100 text-rose-700" };
  }
  if (args.worsened > 0 && args.improved > 0) {
    return { label: "mixed", className: "bg-amber-100 text-amber-700" };
  }
  return { label: "flat", className: "bg-slate-100 text-slate-700" };
}

export default async function GovernanceRecommendationsPage({ searchParams }: RecommendationsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const historyActionKind = String(sp.history_action_kind ?? "").trim();
  const historyResult = String(sp.history_result ?? "").trim();
  const [{ summary, recommendations }, recentActionsRes, latestReviewRes] = await Promise.all([
    buildGovernanceRecommendations({ supabase, orgId }),
    supabase
      .from("task_events")
      .select("id, created_at, event_type, actor_id, actor_type, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["GOVERNANCE_RECOMMENDATION_APPLIED", "GOVERNANCE_RECOMMENDATION_FAILED"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("task_events")
      .select("id, created_at, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "GOVERNANCE_RECOMMENDATIONS_REVIEWED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  if (recentActionsRes.error) {
    throw new Error(`Failed to load recommendation history: ${recentActionsRes.error.message}`);
  }
  if (latestReviewRes.error) {
    throw new Error(`Failed to load latest recommendation review: ${latestReviewRes.error.message}`);
  }

  const recentActions = (recentActionsRes.data ?? []) as RecommendationEventRow[];
  const latestReview = (latestReviewRes.data as ReviewEventRow | null) ?? null;
  const latestReviewPayload = asObject(latestReview?.payload_json);
  const latestReviewSummary = asObject(latestReviewPayload?.summary);
  const latestCriticalCount = numberFromUnknown(latestReviewPayload?.critical_count);
  const latestHighCount = numberFromUnknown(latestReviewPayload?.high_count);
  const latestRecommendationCount = numberFromUnknown(latestReviewPayload?.recommendation_count);
  const availableHistoryActionKinds = Array.from(
    new Set(
      recentActions
        .map((row) => {
          const payload = asObject(row.payload_json);
          return typeof payload?.action_kind === "string" ? payload.action_kind : null;
        })
        .filter((value): value is string => Boolean(value))
    )
  );
  const filteredActions = recentActions.filter((row) => {
    const payload = asObject(row.payload_json);
    const actionKind = typeof payload?.action_kind === "string" ? payload.action_kind : "";
    const rowResult =
      row.event_type === "GOVERNANCE_RECOMMENDATION_FAILED"
        ? "failed"
        : typeof payload?.result === "string"
          ? payload.result
          : "success";
    if (historyActionKind && actionKind !== historyActionKind) {
      return false;
    }
    if (historyResult && rowResult !== historyResult) {
      return false;
    }
    return true;
  });

  const priorityCounts = {
    critical: recommendations.filter((item) => item.priority === "critical").length,
    high: recommendations.filter((item) => item.priority === "high").length,
    medium: recommendations.filter((item) => item.priority === "medium").length,
    low: recommendations.filter((item) => item.priority === "low").length
  };
  const maxPriorityCount = Math.max(1, ...Object.values(priorityCounts));

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-sky-900 p-6 text-white shadow-lg">
        <p className="text-xs uppercase tracking-[0.18em] text-sky-200">Governance AI</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">改善提案センター</h1>
        <p className="mt-3 text-sm text-slate-200">
          承認滞留・失敗率・Trust・予算・インシデントを横断評価し、優先度順に改善アクションを提示します。
        </p>
        <p className="mt-4 inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs">
          組織コンテキスト: {orgId}
        </p>
        <form action={runRecommendationsReviewNow} className="mt-3">
          <button
            type="submit"
            className="inline-flex rounded-md border border-white/30 bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
          >
            今すぐ再評価
          </button>
        </form>
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
      {sp.retry_action_kind && sp.retry_recommendation_id ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">失敗したアクションの再試行</h2>
          <p className="mt-1 text-sm text-amber-800">
            action_kind: <span className="font-mono">{sp.retry_action_kind}</span> / recommendation_id:{" "}
            <span className="font-mono">{sp.retry_recommendation_id}</span>
          </p>
          <form action={applyRecommendationAction} className="mt-3 space-y-2">
            <input type="hidden" name="action_kind" value={sp.retry_action_kind} />
            <input type="hidden" name="recommendation_id" value={sp.retry_recommendation_id} />
            {sp.retry_action_kind === "disable_auto_execute" ? (
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input type="checkbox" name="confirm_risky" value="yes" className="h-4 w-4 rounded border-slate-300" />
                自動実行を停止することを理解しました
              </label>
            ) : null}
            <button
              type="submit"
              className="inline-flex rounded-md border border-amber-400 bg-white px-3 py-2 text-sm text-amber-800 hover:bg-amber-100"
            >
              失敗したアクションを再試行
            </button>
          </form>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">open incidents</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{summary.openIncidents}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <p className="text-xs text-amber-700">pending approvals &gt;24h</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{summary.staleApprovals24h}</p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-xs text-sky-700">failed actions (7d)</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{summary.failedActions7d}</p>
        </div>
        <div className="rounded-xl border border-fuchsia-200 bg-fuchsia-50 p-4 shadow-sm">
          <p className="text-xs text-fuchsia-700">failed chat commands (7d)</p>
          <p className="mt-1 text-2xl font-semibold text-fuchsia-900">{summary.failedChatCommands7d}</p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
          <p className="text-xs text-indigo-700">success rate (7d)</p>
          <p className="mt-1 text-2xl font-semibold text-indigo-900">
            {summary.actionSuccessRate7d !== null ? `${summary.actionSuccessRate7d}%` : "-"}
          </p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <p className="text-xs text-emerald-700">budget remaining</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">
            {summary.budgetRemaining !== null ? `${summary.budgetRemaining}/${summary.budgetLimit}` : "-"}
          </p>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">最新レビュー結果</h2>
        {latestReview ? (
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            <p>実行時刻: {new Date(latestReview.created_at).toLocaleString()}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <p className="rounded-md bg-rose-50 px-3 py-2 text-rose-800">critical: {latestCriticalCount ?? "-"}</p>
              <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">high: {latestHighCount ?? "-"}</p>
              <p className="rounded-md bg-sky-50 px-3 py-2 text-sky-800">
                total recommendations: {latestRecommendationCount ?? "-"}
              </p>
            </div>
            {latestReviewSummary ? (
              <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-medium text-slate-700">summary JSON</summary>
                <pre className="mt-2 overflow-x-auto text-xs text-slate-700">
                  {JSON.stringify(latestReviewSummary, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600">まだ定期レビュー実行履歴はありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">提案優先度分布</h2>
          <span className="text-xs text-slate-500">0件は棒を表示しません</span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(["critical", "high", "medium", "low"] as const).map((priority) => {
            const count = priorityCounts[priority];
            const heightPct = count > 0 ? Math.max(12, Math.round((count / maxPriorityCount) * 100)) : 0;
            return (
              <div key={priority} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="flex h-36 items-end justify-center rounded-md bg-white px-2">
                  {count > 0 ? (
                    <div className={`w-10 rounded-t-md ${barColor(priority)}`} style={{ height: `${heightPct}%` }} />
                  ) : null}
                </div>
                <p className="mt-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {priorityLabel(priority)}
                </p>
                <p className="text-center text-sm font-semibold text-slate-900">{count}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">優先アクション</h2>
        <ul className="mt-4 space-y-3">
          {recommendations.map((item) => (
            <li key={item.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorityClasses(item.priority)}`}>
                  {priorityLabel(item.priority)}
                </span>
                <p className="text-xs text-slate-500">
                  {item.metricLabel}: <span className="font-semibold text-slate-700">{item.metricValue}</span>
                </p>
              </div>
              <p className="mt-2 text-sm font-semibold text-slate-900">{item.title}</p>
              <p className="mt-1 text-sm text-slate-600">{item.description}</p>
              <Link
                href={item.href}
                className="mt-3 inline-flex rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                {item.actionLabel}
              </Link>
              {item.automation ? (
                <form action={applyRecommendationAction} className="mt-2">
                  <input type="hidden" name="recommendation_id" value={item.id} />
                  <input type="hidden" name="action_kind" value={item.automation.kind} />
                  {item.automation.kind === "disable_auto_execute" ? (
                    <label className="mb-2 flex items-center gap-2 text-xs text-slate-700">
                      <input type="checkbox" name="confirm_risky" value="yes" className="h-4 w-4 rounded border-slate-300" />
                      自動実行を停止することを理解しました
                    </label>
                  ) : null}
                  <button
                    type="submit"
                    className="inline-flex rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-100"
                  >
                    {item.automation.label}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">実行履歴</h2>
        <p className="mt-1 text-sm text-slate-600">改善提案の適用履歴と、適用時点メトリクス（baseline）を表示します。</p>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="history_action_kind">
              action_kind
            </label>
            <select
              id="history_action_kind"
              name="history_action_kind"
              defaultValue={historyActionKind}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
            >
              <option value="">すべて</option>
              {availableHistoryActionKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="history_result">
              result
            </label>
            <select
              id="history_result"
              name="history_result"
              defaultValue={historyResult}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
            >
              <option value="">すべて</option>
              <option value="success">success</option>
              <option value="failed">failed</option>
            </select>
          </div>
          <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            フィルタ適用
          </button>
        </form>
        {filteredActions.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {filteredActions.map((row) => {
              const payload = asObject(row.payload_json);
              const actionKind = typeof payload?.action_kind === "string" ? payload.action_kind : "unknown";
              const result =
                row.event_type === "GOVERNANCE_RECOMMENDATION_FAILED"
                  ? "failed"
                  : typeof payload?.result === "string"
                    ? payload.result
                    : "success";
              const recommendationId =
                typeof payload?.recommendation_id === "string" ? payload.recommendation_id : "(unknown)";
              const baseline = asObject(payload?.baseline_summary);
              const followupHref = typeof payload?.followup_href === "string" ? payload.followup_href : null;
              const baselineFailed = numberFromUnknown(baseline?.failedActions7d);
              const baselineStale = numberFromUnknown(baseline?.staleApprovals24h);
              const baselineIncidents = numberFromUnknown(baseline?.openIncidents);
              const failedDelta = baselineFailed !== null ? summary.failedActions7d - baselineFailed : null;
              const staleDelta = baselineStale !== null ? summary.staleApprovals24h - baselineStale : null;
              const incidentDelta = baselineIncidents !== null ? summary.openIncidents - baselineIncidents : null;
              const improvedCount =
                (failedDelta !== null && failedDelta < 0 ? 1 : 0) +
                (staleDelta !== null && staleDelta < 0 ? 1 : 0) +
                (incidentDelta !== null && incidentDelta < 0 ? 1 : 0);
              const worsenedCount =
                (failedDelta !== null && failedDelta > 0 ? 1 : 0) +
                (staleDelta !== null && staleDelta > 0 ? 1 : 0) +
                (incidentDelta !== null && incidentDelta > 0 ? 1 : 0);
              const badge = impactBadge({ improved: improvedCount, worsened: worsenedCount });

              return (
                <li key={row.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-slate-900">{actionKind}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}>{badge.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        result === "failed" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      {result}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    recommendation_id: <span className="font-mono">{recommendationId}</span>
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    actor: <span className="font-mono">{row.actor_id ?? "(system)"}</span>{" "}
                    <span className="text-slate-500">({row.actor_type ?? "unknown"})</span>
                  </p>
                  <p className="mt-1 text-xs text-slate-600">{new Date(row.created_at).toLocaleString()}</p>
                  {followupHref ? (
                    <Link
                      href={followupHref}
                      className="mt-2 inline-flex rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                    >
                      関連ページを開く
                    </Link>
                  ) : null}
                  {baseline ? (
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <p className="rounded-md bg-white px-2 py-1 text-xs text-slate-700">
                        failed(7d): {baselineFailed ?? "-"} → {summary.failedActions7d}
                        {failedDelta !== null ? ` (${deltaLabel(failedDelta)})` : ""}
                      </p>
                      <p className="rounded-md bg-white px-2 py-1 text-xs text-slate-700">
                        pending&gt;24h: {baselineStale ?? "-"} → {summary.staleApprovals24h}
                        {staleDelta !== null ? ` (${deltaLabel(staleDelta)})` : ""}
                      </p>
                      <p className="rounded-md bg-white px-2 py-1 text-xs text-slate-700">
                        incidents: {baselineIncidents ?? "-"} → {summary.openIncidents}
                        {incidentDelta !== null ? ` (${deltaLabel(incidentDelta)})` : ""}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">baseline metric なし</p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">まだ改善提案の実行履歴はありません。</p>
        )}
      </section>
    </section>
  );
}
