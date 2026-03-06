import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type ExecutionDetailPageProps = {
  params: Promise<{ id: string }>;
};

type ExecutionRow = {
  id: string;
  triggered_by_user_id: string | null;
  session_id: string | null;
  session_scope: string | null;
  channel_id: string | null;
  intent_type: string | null;
  execution_status: string;
  execution_ref_type: string | null;
  execution_ref_id: string | null;
  source: string;
  summary_text: string | null;
  metadata_json: unknown;
  created_at: string;
  finished_at: string | null;
};

function statusLabel(status: string) {
  if (status === "done") return "成功";
  if (status === "failed") return "失敗";
  if (status === "declined") return "却下";
  if (status === "skipped") return "スキップ";
  if (status === "running") return "実行中";
  if (status === "pending") return "保留";
  if (status === "cancelled") return "キャンセル";
  return status;
}

function sourceLabel(source: string) {
  if (source === "chat") return "チャット";
  if (source === "slack") return "Slack";
  if (source === "planner") return "プランナー";
  return source;
}

function scopeLabel(scope: string | null) {
  if (scope === "shared") return "共有";
  if (scope === "personal") return "個人";
  if (scope === "channel") return "チャンネル";
  if (!scope) return "未設定";
  return scope;
}

function intentLabel(intent: string | null) {
  if (!intent) return "未設定";
  if (intent === "request_approval") return "承認依頼";
  if (intent === "execute_action") return "アクション実行";
  if (intent === "quick_top_action") return "クイック実行";
  if (intent === "run_workflow") return "ワークフロー実行";
  if (intent === "bulk_retry_failed_workflows") return "失敗WF一括再試行";
  if (intent === "run_planner") return "プランナー実行";
  if (intent === "monitor_settings_update") return "監視設定更新";
  return intent;
}

function executionRefLabel(refType: string | null) {
  if (!refType) return "未設定";
  if (refType === "task") return "タスク";
  if (refType === "action") return "アクション";
  if (refType === "approval") return "承認";
  if (refType === "proposal") return "提案";
  return refType;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export default async function ExecutionDetailPage({ params }: ExecutionDetailPageProps) {
  const { id } = await params;
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("ai_execution_logs")
    .select(
      "id, triggered_by_user_id, session_id, session_scope, channel_id, intent_type, execution_status, execution_ref_type, execution_ref_id, source, summary_text, metadata_json, created_at, finished_at"
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load execution detail: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  const row = data as ExecutionRow;
  const metadata = asObject(row.metadata_json);

  let requesterName: string | null = null;
  if (row.triggered_by_user_id) {
    const { data: requester } = await supabase
      .from("user_profiles")
      .select("display_name")
      .eq("org_id", orgId)
      .eq("user_id", row.triggered_by_user_id)
      .maybeSingle();
    requesterName = (requester?.display_name as string | undefined)?.trim() || null;
  }

  let channelName: string | null = null;
  if (row.channel_id) {
    const { data: channel } = await supabase
      .from("chat_channels")
      .select("name")
      .eq("org_id", orgId)
      .eq("id", row.channel_id)
      .maybeSingle();
    channelName = (channel?.name as string | undefined)?.trim() || null;
  }

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">実行履歴 詳細</h1>
            <p className="mt-2 text-sm text-slate-600">1件の実行を監査用に確認できます。</p>
          </div>
          <Link href="/app/executions" className="rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50">
            実行履歴へ戻る
          </Link>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{statusLabel(row.execution_status)}</span>
          <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{sourceLabel(row.source)}</span>
          <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{scopeLabel(row.session_scope)}</span>
        </div>
        <h2 className="mt-3 text-base font-semibold text-slate-900">{row.summary_text ?? "要約なし"}</h2>
        <dl className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500">作成日時</dt>
            <dd>{new Date(row.created_at).toLocaleString("ja-JP")}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">終了日時</dt>
            <dd>{row.finished_at ? new Date(row.finished_at).toLocaleString("ja-JP") : "未終了"}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">依頼元</dt>
            <dd>{row.triggered_by_user_id ? requesterName ?? "表示名未設定メンバー" : "システム"}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">意図</dt>
            <dd>{intentLabel(row.intent_type)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">チャンネル</dt>
            <dd>{row.channel_id ? channelName ?? "名称未設定チャンネル" : "なし"}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">参照種別</dt>
            <dd>{executionRefLabel(row.execution_ref_type)}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {row.execution_ref_type === "task" && row.execution_ref_id ? (
            <Link href={`/app/tasks/${row.execution_ref_id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
              タスク詳細へ
            </Link>
          ) : null}
          {row.execution_ref_type === "task" && row.execution_ref_id ? (
            <Link href={`/app/tasks/${row.execution_ref_id}/evidence?execution_id=${row.id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
              証跡パックへ
            </Link>
          ) : null}
          {row.channel_id ? (
            <Link href={`/app/chat/channels/${row.channel_id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
              関連チャンネルへ
            </Link>
          ) : null}
          {row.session_id ? (
            <Link href={`/app/chat/audit?session_id=${row.session_id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
              チャット監査へ
            </Link>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">メタデータ</h2>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
          {toRedactedJson(metadata ?? {})}
        </pre>
      </section>
    </section>
  );
}
