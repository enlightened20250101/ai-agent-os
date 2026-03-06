import Link from "next/link";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ExecutionPageProps = {
  searchParams?: Promise<{
    from?: string;
    to?: string;
    source?: string;
    status?: string;
    requester?: string;
    scope?: string;
    intent?: string;
  }>;
};

type LogRow = {
  id: string;
  triggered_by_user_id: string | null;
  session_scope: string | null;
  channel_id: string | null;
  intent_type: string | null;
  execution_status: string;
  execution_ref_type: string | null;
  execution_ref_id: string | null;
  source: string;
  summary_text: string | null;
  created_at: string;
  finished_at: string | null;
  metadata_json: unknown;
};

function parseDate(value: string | undefined, fallback: Date) {
  if (!value) return fallback;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return fallback;
  return d;
}

export default async function ExecutionsPage({ searchParams }: ExecutionPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromDate = parseDate(sp.from, defaultFrom);
  const toDate = parseDate(sp.to, now);

  const status = typeof sp.status === "string" ? sp.status : "all";
  const source = typeof sp.source === "string" ? sp.source : "all";
  const requester = typeof sp.requester === "string" ? sp.requester : "all";
  const scope = typeof sp.scope === "string" ? sp.scope : "all";
  const intent = typeof sp.intent === "string" ? sp.intent : "all";

  let query = supabase
    .from("ai_execution_logs")
    .select(
      "id, triggered_by_user_id, session_scope, channel_id, intent_type, execution_status, execution_ref_type, execution_ref_id, source, summary_text, created_at, finished_at, metadata_json"
    )
    .eq("org_id", orgId)
    .gte("created_at", fromDate.toISOString())
    .lte("created_at", toDate.toISOString())
    .order("created_at", { ascending: false })
    .limit(500);

  if (status !== "all") query = query.eq("execution_status", status);
  if (source !== "all") query = query.eq("source", source);
  if (requester !== "all") query = query.eq("triggered_by_user_id", requester);
  if (scope !== "all") query = query.eq("session_scope", scope);
  if (intent !== "all") query = query.eq("intent_type", intent);

  const { data, error } = await query;
  if (error) {
    const missing =
      error.message.includes('relation "ai_execution_logs" does not exist') ||
      error.message.includes("Could not find the table 'public.ai_execution_logs'");
    if (missing) {
      return (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          `ai_execution_logs` migration 未適用です。`supabase db push` を実行してください。
        </section>
      );
    }
    throw new Error(`Failed to load execution logs: ${error.message}`);
  }

  const rows = (data ?? []) as LogRow[];
  const requesterOptions = Array.from(new Set(rows.map((r) => r.triggered_by_user_id).filter((v): v is string => Boolean(v))));
  const intentOptions = Array.from(new Set(rows.map((r) => r.intent_type).filter((v): v is string => Boolean(v))));
  const doneCount = rows.filter((r) => r.execution_status === "done").length;
  const failedCount = rows.filter((r) => r.execution_status === "failed").length;
  const declinedCount = rows.filter((r) => r.execution_status === "declined").length;
  const successRate = rows.length > 0 ? Math.round((doneCount / rows.length) * 100) : 0;
  const exportParams = new URLSearchParams();
  exportParams.set("from", fromDate.toISOString());
  exportParams.set("to", toDate.toISOString());

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">AI実行履歴</h1>
        <p className="mt-2 text-sm text-slate-600">ワークスペース全体のAI実行を、チャンネル所属に関係なく監査できます。</p>
      </header>

      <form className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-2 md:grid-cols-7">
          <input type="datetime-local" name="from" defaultValue={fromDate.toISOString().slice(0, 16)} className="rounded-md border border-slate-300 px-2 py-2 text-xs" />
          <input type="datetime-local" name="to" defaultValue={toDate.toISOString().slice(0, 16)} className="rounded-md border border-slate-300 px-2 py-2 text-xs" />
          <select name="source" defaultValue={source} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">source: all</option>
            <option value="chat">chat</option>
            <option value="slack">slack</option>
            <option value="planner">planner</option>
          </select>
          <select name="status" defaultValue={status} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">status: all</option>
            <option value="done">done</option>
            <option value="failed">failed</option>
            <option value="declined">declined</option>
            <option value="skipped">skipped</option>
          </select>
          <select name="scope" defaultValue={scope} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">scope: all</option>
            <option value="shared">shared</option>
            <option value="personal">personal</option>
            <option value="channel">channel</option>
          </select>
          <select name="requester" defaultValue={requester} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">requester: all</option>
            {requesterOptions.map((uid) => (
              <option key={uid} value={uid}>
                {uid}
              </option>
            ))}
          </select>
          <select name="intent" defaultValue={intent} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">intent: all</option>
            {intentOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="mt-2 rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800">
          絞り込み
        </button>
        <Link
          href={`/api/executions/export?${exportParams.toString()}`}
          className="ml-2 inline-flex rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
        >
          CSVエクスポート
        </Link>
      </form>

      <section className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">TOTAL</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{rows.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs text-emerald-700">DONE</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{doneCount}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-xs text-rose-700">FAILED</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{failedCount}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-700">SUCCESS RATE</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{successRate}%</p>
          <p className="text-[11px] text-amber-700">declined: {declinedCount}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">該当する実行履歴はありません。</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{row.execution_status}</span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{row.source}</span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{row.session_scope ?? "-"}</span>
                  <span className="text-slate-500">{new Date(row.created_at).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-sm text-slate-800">{row.summary_text ?? row.intent_type ?? "execution"}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  requester: {row.triggered_by_user_id ?? "system"} | intent: {row.intent_type ?? "-"} | ref: {row.execution_ref_type ?? "-"}/
                  {row.execution_ref_id ?? "-"}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {row.execution_ref_type === "task" && row.execution_ref_id ? (
                    <Link href={`/app/tasks/${row.execution_ref_id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
                      タスクへ
                    </Link>
                  ) : null}
                  {row.session_scope === "channel" && row.channel_id ? (
                    <Link href={`/app/chat/channels/${row.channel_id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
                      チャンネルへ
                    </Link>
                  ) : null}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-600">metadata</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">{JSON.stringify(row.metadata_json ?? {}, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
