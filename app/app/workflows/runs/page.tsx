import Link from "next/link";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type WorkflowRunsPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string; status?: string }>;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export default async function WorkflowRunsPage({ searchParams }: WorkflowRunsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const statusFilter = sp.status === "running" || sp.status === "failed" || sp.status === "completed" ? sp.status : "all";
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
        <h1 className="text-xl font-semibold">Workflow Runs</h1>
        <Link href="/app/workflows" className="text-sm underline">
          テンプレートへ戻る
        </Link>
      </div>

      {sp.ok ? (
        <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {sp.ok}
        </p>
      ) : null}
      {sp.error ? (
        <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {sp.error}
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <Link
          href="/app/workflows/runs?status=running"
          className={`rounded-md border p-3 text-sm ${statusFilter === "running" ? "border-sky-300 bg-sky-50" : "border-slate-200 bg-slate-50"}`}
        >
          <p className="text-slate-600">running</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{runningCount}</p>
        </Link>
        <Link
          href="/app/workflows/runs?status=failed"
          className={`rounded-md border p-3 text-sm ${statusFilter === "failed" ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}
        >
          <p className="text-slate-600">failed</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{failedCount}</p>
        </Link>
        <Link
          href="/app/workflows/runs?status=completed"
          className={`rounded-md border p-3 text-sm ${
            statusFilter === "completed" ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50"
          }`}
        >
          <p className="text-slate-600">completed</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{completedCount}</p>
        </Link>
        <Link href="/app/workflows/runs?status=failed" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">retry exhausted runs</p>
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
          {runs.map((run) => (
            <li key={String(run.id)} className="rounded-md border border-slate-200 p-3 text-sm">
              <p className="font-medium text-slate-900">
                <Link href={`/app/workflows/runs/${String(run.id)}`} className="underline">
                  run {String(run.id)}
                </Link>
              </p>
              <p className="text-slate-600">
                task_id: {String(run.task_id)} | status: {String(run.status)} | current_step: {String(run.current_step_key ?? "-")}
              </p>
              <p className="text-slate-500">started_at: {new Date(String(run.started_at)).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-slate-600">workflow run はまだありません。</p>
      )}
    </section>
  );
}
