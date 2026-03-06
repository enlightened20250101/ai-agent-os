import Link from "next/link";
import { StatusNotice } from "@/app/app/StatusNotice";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type WorkflowRunsPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
    status?: string;
    ref_job?: string;
    ref_ts?: string;
    ref_from?: string;
    ref_intent?: string;
  }>;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function runStatusLabel(status: string) {
  if (status === "running") return "実行中";
  if (status === "failed") return "失敗";
  if (status === "completed") return "完了";
  return status;
}

export default async function WorkflowRunsPage({ searchParams }: WorkflowRunsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const statusFilter = sp.status === "running" || sp.status === "failed" || sp.status === "completed" ? sp.status : "all";
  const refJob = typeof sp.ref_job === "string" ? sp.ref_job : "";
  const refTs = typeof sp.ref_ts === "string" ? sp.ref_ts : "";
  const refFrom = typeof sp.ref_from === "string" ? sp.ref_from : "";
  const refIntent = typeof sp.ref_intent === "string" ? sp.ref_intent : "";
  const maxRetriesRaw = Number.parseInt(process.env.WORKFLOW_STEP_MAX_RETRIES ?? "3", 10);
  const maxRetries = Number.isNaN(maxRetriesRaw) ? 3 : Math.max(0, Math.min(20, maxRetriesRaw));

  let runs: Array<Record<string, unknown>> = [];
  let runsQuery = supabase
    .from("workflow_runs")
    .select("id, task_id, template_id, status, current_step_key, started_at, finished_at, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (statusFilter !== "all") {
    runsQuery = runsQuery.eq("status", statusFilter);
  }
  const runsRes = await runsQuery;

  if (runsRes.error) {
    if (!isMissingTableError(runsRes.error.message, "workflow_runs")) {
      throw new Error(`workflow run 取得に失敗しました: ${runsRes.error.message}`);
    }
  } else {
    runs = (runsRes.data ?? []) as Array<Record<string, unknown>>;
  }
  const highlightedRunId = (() => {
    if (refTs) {
      const exact = runs.find((row) => String(row.created_at ?? "") === refTs);
      if (exact?.id) return String(exact.id);
    }
    if (refJob === "workflow_tick") {
      const candidate = runs.find((row) => String(row.status ?? "") === "failed");
      if (candidate?.id) return String(candidate.id);
    }
    return null;
  })();

  let failedCount = 0;
  let runningCount = 0;
  let completedCount = 0;
  if (statusFilter === "all") {
    failedCount = runs.filter((row) => row.status === "failed").length;
    runningCount = runs.filter((row) => row.status === "running").length;
    completedCount = runs.filter((row) => row.status === "completed").length;
  } else if (statusFilter === "failed") {
    failedCount = runs.length;
  } else if (statusFilter === "running") {
    runningCount = runs.length;
  } else if (statusFilter === "completed") {
    completedCount = runs.length;
  }

  let retryExhaustedRunCount = 0;
  const exhaustedStepsRes = await supabase
    .from("workflow_steps")
    .select("workflow_run_id, retry_count")
    .eq("org_id", orgId)
    .eq("status", "failed")
    .gte("retry_count", maxRetries)
    .order("finished_at", { ascending: false })
    .limit(500);
  if (exhaustedStepsRes.error) {
    if (!isMissingTableError(exhaustedStepsRes.error.message, "workflow_steps")) {
      throw new Error(`retry exhausted 集計に失敗しました: ${exhaustedStepsRes.error.message}`);
    }
  } else {
    const ids = new Set((exhaustedStepsRes.data ?? []).map((row) => row.workflow_run_id as string));
    retryExhaustedRunCount = ids.size;
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">ワークフロー実行履歴</h1>
        <Link href="/app/workflows" className="text-sm underline">
          テンプレートへ戻る
        </Link>
      </div>

      <StatusNotice ok={sp.ok} error={sp.error} className="mt-4" />
      {refJob ? (
        <div className="mt-3 rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
          参照元: {refJob}
          {refTs ? ` / ${new Date(refTs).toLocaleString("ja-JP")}` : ""}
        </div>
      ) : null}
      {refFrom || refIntent ? (
        <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
          参照コンテキスト: {refFrom || "unknown"}
          {refIntent ? ` / ${refIntent}` : ""}
          {refTs ? ` / ${new Date(refTs).toLocaleString("ja-JP")}` : ""}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <Link
          href="/app/workflows/runs?status=running"
          className={`rounded-md border p-3 text-sm ${statusFilter === "running" ? "border-sky-300 bg-sky-50" : "border-slate-200 bg-slate-50"}`}
        >
          <p className="text-slate-600">実行中</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{runningCount}</p>
        </Link>
        <Link
          href="/app/workflows/runs?status=failed"
          className={`rounded-md border p-3 text-sm ${statusFilter === "failed" ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}
        >
          <p className="text-slate-600">失敗</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{failedCount}</p>
        </Link>
        <Link
          href="/app/workflows/runs?status=completed"
          className={`rounded-md border p-3 text-sm ${
            statusFilter === "completed" ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50"
          }`}
        >
          <p className="text-slate-600">完了</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{completedCount}</p>
        </Link>
        <Link href="/app/workflows/runs?status=failed" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">再試行上限到達</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{retryExhaustedRunCount}</p>
        </Link>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs">
        <Link href="/app/workflows/runs" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100">
          フィルタをリセット
        </Link>
      </div>

      {runs.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {runs.map((run) => {
            const runId = String(run.id);
            const isRef = highlightedRunId !== null && runId === highlightedRunId;
            return (
            <li key={runId} className={`rounded-md border p-3 text-sm ${isRef ? "border-indigo-300 bg-indigo-50/40" : "border-slate-200"}`}>
              <p className="font-medium text-slate-900">
                <Link href={`/app/workflows/runs/${String(run.id)}`} className="underline">
                  実行詳細を開く
                </Link>
              </p>
              <p className="text-slate-600">
                状態: {runStatusLabel(String(run.status))} | 現在ステップ: {String(run.current_step_key ?? "-")}
              </p>
              <p className="text-slate-500">開始日時: {new Date(String(run.started_at)).toLocaleString("ja-JP")}</p>
            </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-slate-600">ワークフロー実行履歴はまだありません。</p>
      )}
    </section>
  );
}
