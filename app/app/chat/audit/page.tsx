import Link from "next/link";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type AuditPageProps = {
  searchParams?: Promise<{ status?: string; scope?: string; intent?: string }>;
};

type CommandRow = {
  id: string;
  session_id: string;
  intent_id: string;
  execution_status: string;
  execution_ref_type: string | null;
  execution_ref_id: string | null;
  result_json: unknown;
  created_at: string;
  finished_at: string | null;
};

function asObject(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function statusBadgeClass(status: string) {
  if (status === "done") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (status === "running") return "border-sky-300 bg-sky-50 text-sky-800";
  if (status === "pending") return "border-amber-300 bg-amber-50 text-amber-800";
  if (status === "failed") return "border-rose-300 bg-rose-50 text-rose-800";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

export default async function ChatAuditPage({ searchParams }: AuditPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const statusFilter =
    sp.status === "failed" || sp.status === "pending" || sp.status === "running" || sp.status === "done"
      ? sp.status
      : "all";
  const scopeFilter = sp.scope === "shared" || sp.scope === "personal" ? sp.scope : "all";
  const intentFilter = typeof sp.intent === "string" && sp.intent.length > 0 ? sp.intent : "all";

  let commandQuery = supabase
    .from("chat_commands")
    .select("id, session_id, intent_id, execution_status, execution_ref_type, execution_ref_id, result_json, created_at, finished_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (statusFilter !== "all") {
    commandQuery = commandQuery.eq("execution_status", statusFilter);
  }
  const { data: commandsData, error: commandsError } = await commandQuery;
  if (commandsError) {
    throw new Error(`Failed to load chat command logs: ${commandsError.message}`);
  }

  const commands = (commandsData ?? []) as CommandRow[];
  const sessionIds = Array.from(new Set(commands.map((row) => row.session_id)));
  const intentIds = Array.from(new Set(commands.map((row) => row.intent_id)));

  let sessionMap = new Map<string, { scope: string; owner: string | null }>();
  if (sessionIds.length > 0) {
    const { data: sessionsData, error: sessionsError } = await supabase
      .from("chat_sessions")
      .select("id, scope, owner_user_id")
      .eq("org_id", orgId)
      .in("id", sessionIds);
    if (sessionsError) {
      throw new Error(`Failed to load chat sessions: ${sessionsError.message}`);
    }
    sessionMap = new Map(
      (sessionsData ?? []).map((row) => [
        row.id as string,
        {
          scope: row.scope as string,
          owner: (row.owner_user_id as string | null) ?? null
        }
      ])
    );
  }

  let intentMap = new Map<string, { intentType: string; summary: string }>();
  if (intentIds.length > 0) {
    const { data: intentsData, error: intentsError } = await supabase
      .from("chat_intents")
      .select("id, intent_type, intent_json")
      .eq("org_id", orgId)
      .in("id", intentIds);
    if (intentsError) {
      throw new Error(`Failed to load chat intents: ${intentsError.message}`);
    }
    intentMap = new Map(
      (intentsData ?? []).map((row) => {
        const intentJson = asObject(row.intent_json);
        return [
          row.id as string,
          {
            intentType: (row.intent_type as string) ?? "unknown",
            summary: typeof intentJson?.summary === "string" ? intentJson.summary : "intent"
          }
        ];
      })
    );
  }

  let rows = commands;
  if (scopeFilter !== "all") {
    rows = rows.filter((row) => sessionMap.get(row.session_id)?.scope === scopeFilter);
  }
  if (intentFilter !== "all") {
    rows = rows.filter((row) => intentMap.get(row.intent_id)?.intentType === intentFilter);
  }

  const statusCount = {
    done: rows.filter((row) => row.execution_status === "done").length,
    failed: rows.filter((row) => row.execution_status === "failed").length,
    running: rows.filter((row) => row.execution_status === "running").length,
    pending: rows.filter((row) => row.execution_status === "pending").length
  };

  const intentOptions = Array.from(
    new Set(
      Array.from(intentMap.values())
        .map((v) => v.intentType)
        .filter(Boolean)
    )
  ).sort();

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">チャット監査ログ</h1>
          <p className="mt-2 text-sm text-slate-600">
            共有/個人チャットのコマンド実行履歴です。個人チャットはRLSにより本人分のみ表示されます。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Link href="/app/chat/shared" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700">
            共有チャット
          </Link>
          <Link href="/app/chat/me" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700">
            個人チャット
          </Link>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">done</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{statusCount.done}</p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="text-rose-700">failed</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{statusCount.failed}</p>
        </div>
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm">
          <p className="text-sky-700">running</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{statusCount.running}</p>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">pending</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{statusCount.pending}</p>
        </div>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
        <label className="flex items-center gap-2">
          status
          <select name="status" defaultValue={statusFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">all</option>
            <option value="failed">failed</option>
            <option value="pending">pending</option>
            <option value="running">running</option>
            <option value="done">done</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          scope
          <select name="scope" defaultValue={scopeFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">all</option>
            <option value="shared">shared</option>
            <option value="personal">personal</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          intent
          <select name="intent" defaultValue={intentFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">all</option>
            {intentOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-2 py-1">
          絞り込み
        </button>
      </form>

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => {
            const session = sessionMap.get(row.session_id);
            const intent = intentMap.get(row.intent_id);
            const result = asObject(row.result_json);
            const taskId =
              typeof result?.task_id === "string"
                ? result.task_id
                : row.execution_ref_type === "task"
                  ? row.execution_ref_id
                  : null;
            return (
              <li key={row.id} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded-full border px-2 py-0.5 ${statusBadgeClass(row.execution_status)}`}>
                    {row.execution_status}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                    {session?.scope ?? "unknown"}
                  </span>
                  <span className="text-slate-500">{new Date(row.created_at).toLocaleString()}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                    {intent?.intentType ?? "intent"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-800">{intent?.summary ?? "summaryなし"}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-500">command_id: {row.id}</span>
                  {taskId ? (
                    <Link href={`/app/tasks/${taskId}`} className="text-sky-700 underline">
                      task
                    </Link>
                  ) : null}
                </div>
                {result ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate-600">result_json</summary>
                    <pre className="mt-2 overflow-x-auto rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
                      {JSON.stringify(result, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">表示対象のコマンドはありません。</p>
      )}
    </section>
  );
}
