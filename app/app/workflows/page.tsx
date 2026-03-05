import Link from "next/link";
import { StatusNotice } from "@/app/app/StatusNotice";
import { createWorkflowTemplate } from "@/app/app/workflows/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type WorkflowsPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export default async function WorkflowsPage({ searchParams }: WorkflowsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  let templates: Array<Record<string, unknown>> = [];
  const templatesRes = await supabase
    .from("workflow_templates")
    .select("id, name, version, definition_json, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (templatesRes.error) {
    if (!isMissingTableError(templatesRes.error.message, "workflow_templates")) {
      throw new Error(`workflow template 取得に失敗しました: ${templatesRes.error.message}`);
    }
  } else {
    templates = (templatesRes.data ?? []) as Array<Record<string, unknown>>;
  }

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">ワークフローテンプレート</h1>
        <p className="mt-2 text-sm text-slate-600">
          複数ステップの実行テンプレートを作成し、タスク実行を明示的なステートマシンに移行します。
        </p>
        <div className="mt-3">
          <Link href="/app/workflows/runs" className="text-sm underline">
            workflow run 一覧へ
          </Link>
        </div>

        <StatusNotice ok={sp.ok} error={sp.error} className="mt-4" />

        <form action={createWorkflowTemplate} className="mt-5 space-y-3">
          <input
            type="text"
            name="name"
            placeholder="テンプレート名"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            required
          />
          <textarea
            name="steps"
            rows={5}
            placeholder={
              "ステップを1行ずつ入力（title|type|requires_approval）\n例:\nドラフト確認|task_event|false\n人間承認|task_event|true\nメール送信|execute_google_send_email|false"
            }
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="text-xs text-slate-500">
            type は `task_event` または `execute_google_send_email`。3列目は `true/false`（省略可）。
          </p>
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white">
            テンプレートを作成
          </button>
        </form>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">テンプレート一覧</h2>
        {templates.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {templates.map((template) => {
              const def =
                typeof template.definition_json === "object" && template.definition_json !== null
                  ? (template.definition_json as Record<string, unknown>)
                  : {};
              const stepCount = Array.isArray(def.steps) ? def.steps.length : 0;
              return (
                <li key={String(template.id)} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="font-medium text-slate-900">{String(template.name)}</p>
                  <p className="text-slate-600">
                    version: {String(template.version)} | steps: {stepCount} | 作成日時:{" "}
                    {new Date(String(template.created_at)).toLocaleString()}
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer">definition_json</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                      {JSON.stringify(template.definition_json, null, 2)}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">テンプレートはまだありません。</p>
        )}
      </div>
    </section>
  );
}
