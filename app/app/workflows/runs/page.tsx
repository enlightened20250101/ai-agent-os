import Link from "next/link";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type WorkflowRunsPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
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

  let runs: Array<Record<string, unknown>> = [];
  const runsRes = await supabase
    .from("workflow_runs")
    .select("id, task_id, template_id, status, current_step_key, started_at, finished_at, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (runsRes.error) {
    if (!isMissingTableError(runsRes.error.message, "workflow_runs")) {
      throw new Error(`workflow run 取得に失敗しました: ${runsRes.error.message}`);
    }
  } else {
    runs = (runsRes.data ?? []) as Array<Record<string, unknown>>;
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
