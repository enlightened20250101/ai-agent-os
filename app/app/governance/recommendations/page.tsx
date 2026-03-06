import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { applyRecommendationAction, runRecommendationsReviewNow } from "@/app/app/governance/recommendations/actions";
import { buildGovernanceRecommendations } from "@/lib/governance/recommendations";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

function priorityLabel(priority: "critical" | "high" | "medium" | "low") {
  if (priority === "critical") return "最優先";
  if (priority === "high") return "高";
  if (priority === "medium") return "中";
  return "低";
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
    window?: string;
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
    return { label: "改善", className: "bg-emerald-100 text-emerald-700" };
  }
  if (args.worsened > 0 && args.improved === 0) {
    return { label: "悪化", className: "bg-rose-100 text-rose-700" };
  }
  if (args.worsened > 0 && args.improved > 0) {
    return { label: "混在", className: "bg-amber-100 text-amber-700" };
  }
  return { label: "変化なし", className: "bg-slate-100 text-slate-700" };
}

function resolveWindowHours(windowValue: string) {
  if (windowValue === "24h") return 24;
  if (windowValue === "30d") return 24 * 30;
  return 24 * 7;
}

function formatWindowLabel(windowValue: "24h" | "7d" | "30d") {
  if (windowValue === "24h") return "24時間";
  if (windowValue === "30d") return "30日";
  return "7日";
}

function actionKindLabel(kind: string) {
  if (kind === "disable_auto_execute") return "自動実行を一時停止";
  if (kind === "send_approval_reminder") return "承認催促を送信";
  return kind || "不明";
}

function actorTypeLabel(actorType: string | null) {
  if (actorType === "user") return "ユーザー";
  if (actorType === "agent") return "AIエージェント";
  if (actorType === "system") return "システム";
  return "システム";
}

function metricLabelJa(label: string) {
  if (label === "open incidents") return "オープンインシデント";
  if (label === "pending >72h") return "72時間超の承認待ち";
  if (label === "pending >24h") return "24時間超の承認待ち";
  if (label === "failed actions (7d)") return "失敗アクション(7日)";
  if (label === "success rate (7d)") return "成功率(7日)";
  if (label === "overdue chat confirmations") return "期限切れチャット確認";
  if (label === "pending chat confirmations") return "保留中チャット確認";
  if (label === "failed chat commands (7d)") return "失敗チャット実行(7日)";
  if (label === "low trust rows (7d)") return "低信頼スコア件数(7日)";
  if (label === "policy blocks (7d)") return "ポリシーブロック件数(7日)";
  if (label === "daily remaining") return "日次予算残量";
  if (label === "auto execute") return "自動実行状態";
  if (label === "health") return "健全性";
  return label;
}

function metricValueJa(metricLabel: string, metricValue: string) {
  if (metricLabel === "auto execute" && metricValue === "enabled") return "有効";
  if (metricLabel === "health" && metricValue === "stable") return "安定";
  return metricValue;
}

export default async function GovernanceRecommendationsPage({ searchParams }: RecommendationsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const windowFilter = sp.window === "24h" || sp.window === "30d" ? sp.window : "7d";
  const windowHours = resolveWindowHours(windowFilter);
  const windowLabel = formatWindowLabel(windowFilter);
  const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const historyActionKind = String(sp.history_action_kind ?? "").trim();
  const historyResult = String(sp.history_result ?? "").trim();
  const [{ summary, recommendations }, recentActionsRes, latestReviewRes] = await Promise.all([
    buildGovernanceRecommendations({ supabase, orgId, windowHours }),
    supabase
      .from("task_events")
      .select("id, created_at, event_type, actor_id, actor_type, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["GOVERNANCE_RECOMMENDATION_APPLIED", "GOVERNANCE_RECOMMENDATION_FAILED"])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("task_events")
      .select("id, created_at, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "GOVERNANCE_RECOMMENDATIONS_REVIEWED")
      .gte("created_at", windowStartIso)
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
        <p className="text-xs uppercase tracking-[0.18em] text-sky-200">ガバナンスAI</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">改善提案センター</h1>
        <p className="mt-3 text-sm text-slate-200">
          承認滞留・失敗率・Trust・予算・インシデントを横断評価し、優先度順に改善アクションを提示します。
        </p>
        <p className="mt-4 inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs">
          ワークスペース・ガバナンス
        </p>
        <form action={runRecommendationsReviewNow} className="mt-3">
          <input type="hidden" name="window" value={windowFilter} />
          <ConfirmSubmitButton
            label="今すぐ再評価"
            pendingLabel="再評価中..."
            confirmMessage="改善提案レビューを即時実行します。よろしいですか？"
            className="inline-flex rounded-md border border-white/30 bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
          />
        </form>
      </div>

      <StatusNotice ok={sp.ok} error={sp.error} />
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <p className="text-xs text-slate-600">集計期間: {windowLabel}</p>
        <div className="flex items-center gap-2">
          {[
            { value: "24h", label: "24時間" },
            { value: "7d", label: "7日" },
            { value: "30d", label: "30日" }
          ].map((option) => {
            const active = windowFilter === option.value;
            const href = `/app/governance/recommendations?window=${option.value}`;
            return (
              <Link
                key={option.value}
                href={href}
                className={`rounded-md border px-2 py-1 text-xs ${
                  active
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                {option.label}
              </Link>
            );
          })}
        </div>
      </section>
      {sp.retry_action_kind && sp.retry_recommendation_id ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">失敗したアクションの再試行</h2>
          <p className="mt-1 text-sm text-amber-800">
            前回失敗した改善アクションを再試行します（{actionKindLabel(sp.retry_action_kind)}）。
          </p>
          <form action={applyRecommendationAction} className="mt-3 space-y-2">
            <input type="hidden" name="window" value={windowFilter} />
            <input type="hidden" name="action_kind" value={sp.retry_action_kind} />
            <input type="hidden" name="recommendation_id" value={sp.retry_recommendation_id} />
            {sp.retry_action_kind === "disable_auto_execute" ? (
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input type="checkbox" name="confirm_risky" value="yes" className="h-4 w-4 rounded border-slate-300" />
                自動実行を停止することを理解しました
              </label>
            ) : null}
            <ConfirmSubmitButton
              label="失敗したアクションを再試行"
              pendingLabel="再試行中..."
              confirmMessage="失敗した改善アクションを再試行します。実行しますか？"
              className="inline-flex rounded-md border border-amber-400 bg-white px-3 py-2 text-sm text-amber-800 hover:bg-amber-100"
            />
          </form>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">オープンインシデント</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{summary.openIncidents}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <p className="text-xs text-amber-700">24時間超の承認待ち</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{summary.staleApprovals24h}</p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-xs text-sky-700">失敗アクション ({windowLabel})</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{summary.failedActions7d}</p>
        </div>
        <div className="rounded-xl border border-fuchsia-200 bg-fuchsia-50 p-4 shadow-sm">
          <p className="text-xs text-fuchsia-700">失敗チャット実行 ({windowLabel})</p>
          <p className="mt-1 text-2xl font-semibold text-fuchsia-900">{summary.failedChatCommands7d}</p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
          <p className="text-xs text-indigo-700">成功率 ({windowLabel})</p>
          <p className="mt-1 text-2xl font-semibold text-indigo-900">
            {summary.actionSuccessRate7d !== null ? `${summary.actionSuccessRate7d}%` : "-"}
          </p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <p className="text-xs text-emerald-700">予算残量</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">
            {summary.budgetRemaining !== null ? `${summary.budgetRemaining}/${summary.budgetLimit}` : "-"}
          </p>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">最新レビュー結果</h2>
        {latestReview ? (
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            <p>実行時刻: {new Date(latestReview.created_at).toLocaleString("ja-JP")}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <p className="rounded-md bg-rose-50 px-3 py-2 text-rose-800">最優先: {latestCriticalCount ?? "-"}</p>
              <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">高優先: {latestHighCount ?? "-"}</p>
              <p className="rounded-md bg-sky-50 px-3 py-2 text-sky-800">
                提案総数: {latestRecommendationCount ?? "-"}
              </p>
            </div>
            {latestReviewSummary ? (
              <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-medium text-slate-700">サマリーJSON</summary>
                <pre className="mt-2 overflow-x-auto text-xs text-slate-700">
                  {toRedactedJson(latestReviewSummary)}
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
                  {metricLabelJa(item.metricLabel)}:{" "}
                  <span className="font-semibold text-slate-700">{metricValueJa(item.metricLabel, item.metricValue)}</span>
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
                  <input type="hidden" name="window" value={windowFilter} />
                  <input type="hidden" name="recommendation_id" value={item.id} />
                  <input type="hidden" name="action_kind" value={item.automation.kind} />
                  {item.automation.kind === "disable_auto_execute" ? (
                    <label className="mb-2 flex items-center gap-2 text-xs text-slate-700">
                      <input type="checkbox" name="confirm_risky" value="yes" className="h-4 w-4 rounded border-slate-300" />
                      自動実行を停止することを理解しました
                    </label>
                  ) : null}
                  <ConfirmSubmitButton
                    label={item.automation.label}
                    pendingLabel="適用中..."
                    confirmMessage={`改善アクション（${actionKindLabel(item.automation.kind)}）を適用します。実行しますか？`}
                    className="inline-flex rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-100"
                  />
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">実行履歴</h2>
        <p className="mt-1 text-sm text-slate-600">改善提案の適用履歴と、適用時点メトリクス（基準値）を表示します。</p>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <input type="hidden" name="window" value={windowFilter} />
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="history_action_kind">
              アクション種別
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
                  {actionKindLabel(kind)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="history_result">
              結果
            </label>
            <select
              id="history_result"
              name="history_result"
              defaultValue={historyResult}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
            >
              <option value="">すべて</option>
              <option value="success">成功</option>
              <option value="failed">失敗</option>
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
              const actionKind = typeof payload?.action_kind === "string" ? payload.action_kind : "不明";
              const result =
                row.event_type === "GOVERNANCE_RECOMMENDATION_FAILED"
                  ? "失敗"
                  : typeof payload?.result === "string"
                    ? payload.result === "success"
                      ? "成功"
                      : payload.result === "failed"
                        ? "失敗"
                        : payload.result
                    : "成功";
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
                    <p className="font-medium text-slate-900">{actionKindLabel(actionKind)}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}>{badge.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        result === "失敗" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      {result}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">対象: {followupHref ? "関連運用項目" : "改善項目"}</p>
                  <p className="mt-1 text-xs text-slate-600">実行者: {actorTypeLabel(row.actor_type)}</p>
                  <p className="mt-1 text-xs text-slate-600">{new Date(row.created_at).toLocaleString("ja-JP")}</p>
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
                        失敗アクション({windowLabel}): {baselineFailed ?? "-"} → {summary.failedActions7d}
                        {failedDelta !== null ? ` (${deltaLabel(failedDelta)})` : ""}
                      </p>
                      <p className="rounded-md bg-white px-2 py-1 text-xs text-slate-700">
                        24時間超 保留承認: {baselineStale ?? "-"} → {summary.staleApprovals24h}
                        {staleDelta !== null ? ` (${deltaLabel(staleDelta)})` : ""}
                      </p>
                      <p className="rounded-md bg-white px-2 py-1 text-xs text-slate-700">
                        インシデント: {baselineIncidents ?? "-"} → {summary.openIncidents}
                        {incidentDelta !== null ? ` (${deltaLabel(incidentDelta)})` : ""}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">ベースライン指標なし</p>
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
