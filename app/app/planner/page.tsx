import { runPlannerNow } from "@/app/app/planner/actions";
import Link from "next/link";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type PlannerPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
    planner_run_id?: string;
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

function parseRunSummary(payload: unknown) {
  if (typeof payload !== "object" || payload === null) {
    return {
      createdProposals: 0,
      requestedMaxProposals: 0,
      effectiveMaxProposals: 0,
      consideredSignals: 0,
      totalSignalItems: 0,
      feedback: null as null | {
        acceptanceRate: number;
        rejectionRate: number;
        topRejectReasons: Array<{ reason: string; count: number }>;
      },
      breakdown: [] as Array<{ kind: string; count: number }>
    };
  }
  const row = payload as Record<string, unknown>;
  const breakdownRaw = Array.isArray(row.signal_breakdown) ? row.signal_breakdown : [];
  const breakdown = breakdownRaw
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const b = item as Record<string, unknown>;
      const kind = typeof b.kind === "string" ? b.kind : "unknown";
      const count = typeof b.count === "number" ? b.count : Number(b.count ?? 0);
      return { kind, count: Number.isFinite(count) ? count : 0 };
    })
    .filter((v): v is { kind: string; count: number } => v !== null);
  return {
    createdProposals:
      typeof row.created_proposals === "number" ? row.created_proposals : Number(row.created_proposals ?? 0),
    requestedMaxProposals:
      typeof row.requested_max_proposals === "number"
        ? row.requested_max_proposals
        : Number(row.requested_max_proposals ?? 0),
    effectiveMaxProposals:
      typeof row.effective_max_proposals === "number"
        ? row.effective_max_proposals
        : Number(row.effective_max_proposals ?? 0),
    consideredSignals:
      typeof row.considered_signals === "number" ? row.considered_signals : Number(row.considered_signals ?? 0),
    totalSignalItems:
      typeof row.total_signal_items === "number" ? row.total_signal_items : Number(row.total_signal_items ?? 0),
    feedback:
      typeof row.feedback === "object" && row.feedback !== null
        ? (() => {
            const feedback = row.feedback as Record<string, unknown>;
            const rawReasons = Array.isArray(feedback.top_reject_reasons) ? feedback.top_reject_reasons : [];
            const topRejectReasons = rawReasons
              .map((item) => {
                if (typeof item !== "object" || item === null) return null;
                const r = item as Record<string, unknown>;
                const reason = typeof r.reason === "string" ? r.reason : "unknown";
                const count = typeof r.count === "number" ? r.count : Number(r.count ?? 0);
                return { reason, count: Number.isFinite(count) ? count : 0 };
              })
              .filter((v): v is { reason: string; count: number } => v !== null);
            return {
              acceptanceRate:
                typeof feedback.acceptance_rate === "number"
                  ? feedback.acceptance_rate
                  : Number(feedback.acceptance_rate ?? 0),
              rejectionRate:
                typeof feedback.rejection_rate === "number"
                  ? feedback.rejection_rate
                  : Number(feedback.rejection_rate ?? 0),
              topRejectReasons
            };
          })()
        : null,
    breakdown
  };
}

export default async function PlannerPage({ searchParams }: PlannerPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const refFrom = typeof sp.ref_from === "string" ? sp.ref_from : "";
  const refIntent = typeof sp.ref_intent === "string" ? sp.ref_intent : "";
  const refTs = typeof sp.ref_ts === "string" ? sp.ref_ts : "";
  const plannerRunIdFilter =
    typeof sp.planner_run_id === "string" && sp.planner_run_id.trim().length > 0
      ? sp.planner_run_id.trim()
      : "";

  const [{ data: runs, error }, { data: proposals, error: proposalsError }, { data: monitorEvents, error: monitorEventsError }] = await Promise.all([
    supabase
      .from("planner_runs")
      .select("id, status, started_at, finished_at, summary_json, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("task_proposals")
      .select("id, status, policy_status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("proposal_events")
      .select("id, event_type, payload_json, created_at")
      .eq("org_id", orgId)
      .in("event_type", ["MONITOR_DECISION_RECORDED", "MONITOR_TICK_FINISHED"])
      .order("created_at", { ascending: false })
      .limit(20)
  ]);

  const plannerMissing = error ? isMissingTableError(error.message, "planner_runs") : false;
  const proposalsMissing = proposalsError ? isMissingTableError(proposalsError.message, "task_proposals") : false;
  const monitorEventsMissing = monitorEventsError ? isMissingTableError(monitorEventsError.message, "proposal_events") : false;

  if (error && !plannerMissing) {
    throw new Error(`Failed to load planner runs: ${error.message}`);
  }
  if (proposalsError && !proposalsMissing) {
    throw new Error(`Failed to load proposals: ${proposalsError.message}`);
  }
  if (monitorEventsError && !monitorEventsMissing) {
    throw new Error(`Failed to load monitor proposal events: ${monitorEventsError.message}`);
  }

  const plannerRuns = plannerMissing ? [] : runs ?? [];
  const proposalRows = proposalsMissing ? [] : proposals ?? [];
  const monitorEventRows = monitorEventsMissing ? [] : (monitorEvents ?? []);
  const highlightedPlannerRunId = (() => {
    if (refTs) {
      const exact = plannerRuns.find((run) => String(run.created_at) === refTs);
      if (exact?.id) return String(exact.id);
    }
    if (refIntent === "run_planner") {
      const failedRun = plannerRuns.find((run) => String(run.status) === "failed");
      if (failedRun?.id) return String(failedRun.id);
      return plannerRuns[0]?.id ? String(plannerRuns[0].id) : null;
    }
    return null;
  })();
  const proposedCount = proposalRows.filter((row) => row.status === "proposed").length;
  const acceptedCount = proposalRows.filter((row) => row.status === "accepted").length;
  const rejectedCount = proposalRows.filter((row) => row.status === "rejected").length;
  const blockPolicyCount = proposalRows.filter((row) => row.policy_status === "block").length;
  const runCompleted = plannerRuns.filter((row) => row.status === "completed").length;
  const runFailed = plannerRuns.filter((row) => row.status === "failed").length;

  const chartRows = [
    { key: "run_completed", label: "完了run", count: runCompleted, color: "bg-emerald-500" },
    { key: "run_failed", label: "失敗run", count: runFailed, color: "bg-rose-500" },
    { key: "proposed", label: "提案中", count: proposedCount, color: "bg-amber-500" },
    { key: "accepted", label: "受入済み", count: acceptedCount, color: "bg-teal-500" },
    { key: "rejected", label: "却下", count: rejectedCount, color: "bg-rose-500" },
    { key: "policy_block", label: "ポリシーブロック", count: blockPolicyCount, color: "bg-fuchsia-500" }
  ];
  const maxCount = Math.max(1, ...chartRows.map((row) => row.count));

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">プランナー</h1>
          <p className="mt-2 text-sm text-slate-600">
            自律プランナーを実行し、最近のワークフローシグナルから組織向け提案を生成します。
          </p>
        </div>

        <form action={runPlannerNow}>
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800">
            今すぐプランナー実行
          </button>
        </form>
      </div>

      {sp.ok ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{sp.ok}</p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p>
      ) : null}
      {refFrom || refIntent || refTs ? (
        <p className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
          参照コンテキスト: {refFrom || "unknown"}
          {refIntent ? ` / ${refIntent}` : ""}
          {refTs ? ` / ${new Date(refTs).toLocaleString("ja-JP")}` : ""}
        </p>
      ) : null}
      {plannerRunIdFilter ? (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          planner_run_id で表示中: {plannerRunIdFilter}
        </p>
      ) : null}
      {plannerMissing || proposalsMissing ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {plannerMissing && proposalsMissing
            ? "`planner_runs` / `task_proposals` テーブルが未適用です。`supabase db push` を実行してください。"
            : plannerMissing
              ? "`planner_runs` テーブルが未適用です。`supabase db push` を実行してください。"
              : "`task_proposals` テーブルが未適用です。`supabase db push` を実行してください。"}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-600">完了run</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{runCompleted}</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${runFailed > 0 ? "border-rose-300 bg-rose-100" : "border-rose-200 bg-rose-50"}`}>
          <p className="text-rose-700">失敗run</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{runFailed}</p>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">提案中</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{proposedCount}</p>
        </div>
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">受入済み</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{acceptedCount}</p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="text-rose-700">却下</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{rejectedCount}</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${blockPolicyCount > 0 ? "border-fuchsia-300 bg-fuchsia-100" : "border-fuchsia-200 bg-fuchsia-50"}`}>
          <p className="text-fuchsia-700">ポリシーブロック</p>
          <p className="mt-1 text-2xl font-semibold text-fuchsia-900">{blockPolicyCount}</p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">プランナー指標（縦棒）</p>
          <span className="text-xs text-slate-500">0件は棒なし</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {chartRows.map((row) => {
            const heightPct = row.count > 0 ? Math.max(12, Math.round((row.count / maxCount) * 100)) : 0;
            return (
              <div key={row.key} className="rounded-lg border border-slate-100 bg-white p-3">
                <div className="flex h-36 items-end justify-center rounded-md bg-slate-50">
                  {row.count > 0 ? <div className={`w-10 rounded-t-md ${row.color}`} style={{ height: `${heightPct}%` }} /> : null}
                </div>
                <p className="mt-2 text-center font-mono text-[11px] text-slate-600">{row.label}</p>
                <p className="text-center text-sm font-semibold text-slate-900">{row.count}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold">最近のプランナー実行</h2>
        {plannerRuns.length > 0 ? (
          <ul className="mt-3 space-y-3">
            {plannerRuns.map((run) => (
              <li
                key={run.id}
                id={highlightedPlannerRunId !== null && String(run.id) === highlightedPlannerRunId ? "ref-target" : undefined}
                className={`rounded-md border p-3 text-sm text-slate-700 ${
                  (plannerRunIdFilter && run.id === plannerRunIdFilter) || (highlightedPlannerRunId !== null && String(run.id) === highlightedPlannerRunId)
                    ? "border-sky-400 bg-sky-50"
                    : run.status === "failed"
                      ? "border-rose-300 bg-rose-50"
                      : "border-slate-200"
                }`}
              >
                {(() => {
                  const summary = parseRunSummary(run.summary_json);
                  return (
                    <div className="mb-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs">
                      <p className="font-medium text-slate-700">入力シグナル内訳</p>
                      <p className="mt-1 text-slate-600">
                        生成提案={summary.createdProposals} / 対象シグナル={summary.consideredSignals} /
                        シグナル総件数={summary.totalSignalItems}
                      </p>
                      <p className="mt-1 text-slate-600">
                        最大提案数={summary.effectiveMaxProposals || summary.requestedMaxProposals}/
                        {summary.requestedMaxProposals || "-"}{" "}
                        {summary.feedback
                          ? `| 受入率=${summary.feedback.acceptanceRate}% 却下率=${summary.feedback.rejectionRate}%`
                          : null}
                      </p>
                      {summary.breakdown.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {summary.breakdown.map((item) => (
                            <span key={`${run.id as string}-${item.kind}`} className="rounded-full border border-slate-300 bg-white px-2 py-1">
                              {item.kind}: {item.count}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {summary.feedback && summary.feedback.topRejectReasons.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {summary.feedback.topRejectReasons.map((item) => (
                            <span
                              key={`${run.id as string}-reject-${item.reason}`}
                              className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700"
                            >
                              却下:{item.reason} ({item.count})
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
                <p>
                  ステータス: <span className="font-medium">{run.status as string}</span>
                </p>
                <p>開始: {new Date(run.started_at as string).toLocaleString()}</p>
                <p>
                  終了: {run.finished_at ? new Date(run.finished_at as string).toLocaleString() : "（実行中）"}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer font-medium">サマリーJSON</summary>
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                    {toRedactedJson(run.summary_json)}
                  </pre>
                </details>
                <div className="mt-2">
                  <Link href={`/api/planner/runs/${run.id as string}`} className="text-xs underline">
                    実行詳細JSON
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">プランナー実行履歴はまだありません。</p>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold">監視判定イベント（相互参照）</h2>
        {monitorEventRows.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {monitorEventRows.map((event) => {
              const payload =
                typeof event.payload_json === "object" && event.payload_json !== null
                  ? (event.payload_json as Record<string, unknown>)
                  : null;
              const decisionReason =
                typeof payload?.decision_reason === "string" ? payload.decision_reason : "unknown";
              const status = typeof payload?.status === "string" ? payload.status : null;
              const score = typeof payload?.signal_score === "number" ? payload.signal_score : null;
              const minScore =
                typeof payload?.min_required_score === "number" ? payload.min_required_score : null;
              const monitorRunId =
                typeof payload?.monitor_run_id === "string" ? payload.monitor_run_id : null;
              return (
                <li key={event.id as string} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                      {event.event_type as string}
                    </span>
                    {status ? (
                      <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                        status={status}
                      </span>
                    ) : null}
                    <span className="text-slate-500">{new Date(event.created_at as string).toLocaleString("ja-JP")}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    reason={decisionReason}
                    {score !== null ? ` | score=${score}` : ""}
                    {minScore !== null ? ` / min=${minScore}` : ""}
                    {monitorRunId ? (
                      <>
                        {" "}
                        |{" "}
                        <Link
                          href={`/app/monitor?window=7d&monitor_run_id=${monitorRunId}`}
                          className="text-sky-700 underline"
                        >
                          monitor_run_id={monitorRunId}
                        </Link>
                      </>
                    ) : null}
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate-600">payload JSON</summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                      {toRedactedJson(event.payload_json)}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-500">監視判定イベントはまだありません。</p>
        )}
      </div>
    </section>
  );
}
