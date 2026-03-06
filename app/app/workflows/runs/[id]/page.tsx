import { notFound } from "next/navigation";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { advanceWorkflowRunAction, retryWorkflowRunAction } from "@/app/app/workflows/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type WorkflowRunDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

function runStatusLabel(status: string) {
  if (status === "running") return "実行中";
  if (status === "failed") return "失敗";
  if (status === "completed") return "完了";
  return status;
}

function stepTypeLabel(stepType: string) {
  if (stepType === "task_event") return "タスクイベント";
  if (stepType === "execute_google_send_email") return "Googleメール送信";
  return stepType;
}

export default async function WorkflowRunDetailPage({ params, searchParams }: WorkflowRunDetailPageProps) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: run, error: runError } = await supabase
    .from("workflow_runs")
    .select("id, task_id, template_id, status, current_step_key, started_at, finished_at, created_at")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();

  if (runError) {
    throw new Error(`workflow run 取得に失敗しました: ${runError.message}`);
  }
  if (!run) {
    notFound();
  }

  const { data: steps, error: stepsError } = await supabase
    .from("workflow_steps")
    .select("id, step_key, step_index, step_type, status, input_json, output_json, error_json, started_at, finished_at")
    .eq("org_id", orgId)
    .eq("workflow_run_id", id)
    .order("step_index", { ascending: true });

  if (stepsError) {
    throw new Error(`workflow step 取得に失敗しました: ${stepsError.message}`);
  }

  const failedStep = (steps ?? []).find((step) => step.status === "failed") ?? null;
  const failureMessage =
    failedStep && typeof failedStep.error_json === "object" && failedStep.error_json !== null
      ? ((failedStep.error_json as Record<string, unknown>).message as string | undefined)
      : undefined;

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">ワークフロー実行詳細</h1>
        <p className="mt-2 text-sm text-slate-600">状態: {runStatusLabel(String(run.status))}</p>
        {failureMessage ? (
          <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            失敗理由: {failureMessage}
          </p>
        ) : null}
      </div>

      <StatusNotice ok={sp.ok} error={sp.error} />

      {String(run.status) === "running" ? (
        <form action={advanceWorkflowRunAction}>
          <input type="hidden" name="workflow_run_id" value={String(run.id)} />
          <ConfirmSubmitButton
            label="次のステップへ進める"
            pendingLabel="進行中..."
            confirmMessage="このワークフロー実行を次ステップへ進めます。実行しますか？"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white"
          />
        </form>
      ) : null}
      {String(run.status) === "failed" ? (
        <form action={retryWorkflowRunAction}>
          <input type="hidden" name="workflow_run_id" value={String(run.id)} />
          <ConfirmSubmitButton
            label="失敗したステップを再試行"
            pendingLabel="再試行中..."
            confirmMessage="失敗したワークフロー実行を再試行します。実行しますか？"
            className="rounded-md bg-amber-700 px-4 py-2 text-sm text-white hover:bg-amber-600"
          />
        </form>
      ) : null}

      <div>
        <h2 className="text-lg font-semibold">ステップ一覧</h2>
        {steps && steps.length > 0 ? (
          <ul className="mt-3 space-y-3">
            {steps.map((step) => (
              <li key={String(step.id)} className="rounded-md border border-slate-200 p-3 text-sm">
                <p className="font-medium text-slate-900">
                  #{String(step.step_index)} {String(step.step_key)} ({runStatusLabel(String(step.status))})
                </p>
                <p className="text-slate-600">種別: {stepTypeLabel(String(step.step_type))}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer">入力/出力/エラー</summary>
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                    {toRedactedJson({
                      input_json: step.input_json,
                      output_json: step.output_json,
                      error_json: step.error_json
                    })}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">ステップはありません。</p>
        )}
      </div>
    </section>
  );
}
