import { runPlannerNow } from "@/app/app/planner/actions";
import Link from "next/link";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type PlannerPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

function parseRunSummary(payload: unknown) {
  if (typeof payload !== "object" || payload === null) {
    return {
      createdProposals: 0,
      consideredSignals: 0,
      totalSignalItems: 0,
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
    consideredSignals:
      typeof row.considered_signals === "number" ? row.considered_signals : Number(row.considered_signals ?? 0),
    totalSignalItems:
      typeof row.total_signal_items === "number" ? row.total_signal_items : Number(row.total_signal_items ?? 0),
    breakdown
  };
}

export default async function PlannerPage({ searchParams }: PlannerPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  const [{ data: runs, error }, { data: proposals, error: proposalsError }] = await Promise.all([
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
      .limit(200)
  ]);

  if (error) {
    throw new Error(`Failed to load planner runs: ${error.message}`);
  }
  if (proposalsError) {
    throw new Error(`Failed to load proposals: ${proposalsError.message}`);
  }

  const plannerRuns = runs ?? [];
  const proposalRows = proposals ?? [];
  const proposedCount = proposalRows.filter((row) => row.status === "proposed").length;
  const acceptedCount = proposalRows.filter((row) => row.status === "accepted").length;
  const rejectedCount = proposalRows.filter((row) => row.status === "rejected").length;
  const blockPolicyCount = proposalRows.filter((row) => row.policy_status === "block").length;
  const runCompleted = plannerRuns.filter((row) => row.status === "completed").length;
  const runFailed = plannerRuns.filter((row) => row.status === "failed").length;

  const chartRows = [
    { key: "run_completed", label: "run_completed", count: runCompleted, color: "bg-emerald-500" },
    { key: "run_failed", label: "run_failed", count: runFailed, color: "bg-rose-500" },
    { key: "proposed", label: "proposed", count: proposedCount, color: "bg-amber-500" },
    { key: "accepted", label: "accepted", count: acceptedCount, color: "bg-teal-500" },
    { key: "rejected", label: "rejected", count: rejectedCount, color: "bg-rose-500" },
    { key: "policy_block", label: "policy_block", count: blockPolicyCount, color: "bg-fuchsia-500" }
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

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-600">run completed</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{runCompleted}</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${runFailed > 0 ? "border-rose-300 bg-rose-100" : "border-rose-200 bg-rose-50"}`}>
          <p className="text-rose-700">run failed</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{runFailed}</p>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">proposed</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{proposedCount}</p>
        </div>
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">accepted</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{acceptedCount}</p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="text-rose-700">rejected</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{rejectedCount}</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${blockPolicyCount > 0 ? "border-fuchsia-300 bg-fuchsia-100" : "border-fuchsia-200 bg-fuchsia-50"}`}>
          <p className="text-fuchsia-700">policy block</p>
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
              <li key={run.id} className={`rounded-md border p-3 text-sm text-slate-700 ${run.status === "failed" ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}>
                {(() => {
                  const summary = parseRunSummary(run.summary_json);
                  return (
                    <div className="mb-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs">
                      <p className="font-medium text-slate-700">入力シグナル内訳</p>
                      <p className="mt-1 text-slate-600">
                        created_proposals={summary.createdProposals} / considered_signals={summary.consideredSignals} /
                        total_signal_items={summary.totalSignalItems}
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
                    </div>
                  );
                })()}
                <p>
                  status: <span className="font-medium">{run.status as string}</span>
                </p>
                <p>started_at: {new Date(run.started_at as string).toLocaleString()}</p>
                <p>
                  finished_at: {run.finished_at ? new Date(run.finished_at as string).toLocaleString() : "（実行中）"}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer font-medium">summary_json</summary>
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                    {JSON.stringify(run.summary_json, null, 2)}
                  </pre>
                </details>
                <div className="mt-2">
                  <Link href={`/api/planner/runs/${run.id as string}`} className="text-xs underline">
                    run詳細JSON
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">プランナー実行履歴はまだありません。</p>
        )}
      </div>
    </section>
  );
}
