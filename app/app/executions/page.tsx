import Link from "next/link";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type ExecutionPageProps = {
  searchParams?: Promise<{
    window?: string;
    from?: string;
    to?: string;
    source?: string;
    status?: string;
    requester?: string;
    scope?: string;
    intent?: string;
    channel?: string;
    incident?: string;
    session_id?: string;
  }>;
};

type LogRow = {
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

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function resolveWindowHours(windowValue: string) {
  if (windowValue === "24h") return 24;
  if (windowValue === "30d") return 24 * 30;
  return 24 * 7;
}

function formatWindowLabel(windowValue: "24h" | "7d" | "30d") {
  if (windowValue === "24h") return "24時間";
  if (windowValue === "30d") return "30日";
  return "7日";
}

function statusLabel(status: string) {
  if (status === "done") return "成功";
  if (status === "failed") return "失敗";
  if (status === "declined") return "却下";
  if (status === "skipped") return "スキップ";
  if (status === "running") return "実行中";
  if (status === "pending") return "保留";
  return status;
}

function statusBadgeClass(status: string) {
  if (status === "done") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (status === "failed") return "border-rose-300 bg-rose-50 text-rose-800";
  if (status === "running") return "border-sky-300 bg-sky-50 text-sky-800";
  if (status === "pending") return "border-amber-300 bg-amber-50 text-amber-800";
  if (status === "declined") return "border-slate-400 bg-slate-100 text-slate-800";
  if (status === "skipped") return "border-slate-300 bg-slate-50 text-slate-700";
  return "border-slate-300 bg-slate-50 text-slate-700";
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
  if (!scope) return "-";
  return scope;
}

function intentLabel(intent: string | null) {
  if (!intent) return "-";
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
  if (!refType) return "-";
  if (refType === "task") return "タスク";
  if (refType === "action") return "アクション";
  if (refType === "approval") return "承認";
  if (refType === "proposal") return "提案";
  return refType;
}

function getRecoveryPath(value: unknown) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/app/")) return null;
  return value;
}

function withRefContext(path: string, params: { from: string; intent?: string | null; ts?: string | null }) {
  const [base, query = ""] = path.split("?");
  const sp = new URLSearchParams(query);
  sp.set("ref_from", params.from);
  if (params.intent && params.intent.length > 0) {
    sp.set("ref_intent", params.intent);
  }
  if (params.ts && params.ts.length > 0) {
    sp.set("ref_ts", params.ts);
  }
  const qs = sp.toString();
  const withQuery = qs.length > 0 ? `${base}?${qs}` : base;
  return `${withQuery}#ref-target`;
}

export default async function ExecutionsPage({ searchParams }: ExecutionPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  const now = new Date();
  const windowFilter = sp.window === "24h" || sp.window === "30d" ? sp.window : "7d";
  const windowLabel = formatWindowLabel(windowFilter);
  const windowHours = resolveWindowHours(windowFilter);
  const defaultFrom = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const fromDate = parseDate(sp.from, defaultFrom);
  const toDate = parseDate(sp.to, now);

  const status = typeof sp.status === "string" ? sp.status : "all";
  const source = typeof sp.source === "string" ? sp.source : "all";
  const requester = typeof sp.requester === "string" ? sp.requester : "all";
  const scope = typeof sp.scope === "string" ? sp.scope : "all";
  const intent = typeof sp.intent === "string" ? sp.intent : "all";
  const channel = typeof sp.channel === "string" ? sp.channel : "all";
  const incident = typeof sp.incident === "string" ? sp.incident : "all";
  const sessionId = typeof sp.session_id === "string" && sp.session_id.trim().length > 0 ? sp.session_id.trim() : "";

  let query = supabase
    .from("ai_execution_logs")
    .select(
      "id, triggered_by_user_id, session_id, session_scope, channel_id, intent_type, execution_status, execution_ref_type, execution_ref_id, source, summary_text, created_at, finished_at, metadata_json"
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
  if (channel !== "all") query = query.eq("channel_id", channel);
  if (sessionId) query = query.eq("session_id", sessionId);

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

  const allRows = (data ?? []) as LogRow[];
  const rows =
    incident === "blocked"
      ? allRows.filter((row) => {
          const meta = asObject(row.metadata_json);
          return meta?.blocked_by_incident === true;
        })
      : allRows;
  const requesterOptions = Array.from(new Set(rows.map((r) => r.triggered_by_user_id).filter((v): v is string => Boolean(v))));
  const intentOptions = Array.from(new Set(rows.map((r) => r.intent_type).filter((v): v is string => Boolean(v))));
  const channelOptions = Array.from(new Set(rows.map((r) => r.channel_id).filter((v): v is string => Boolean(v))));
  let requesterNameById = new Map<string, string>();
  let channelNameById = new Map<string, string>();
  if (requesterOptions.length > 0) {
    const profilesRes = await supabase.from("user_profiles").select("user_id, display_name").eq("org_id", orgId).in("user_id", requesterOptions);
    if (!profilesRes.error) {
      requesterNameById = new Map(
        (profilesRes.data ?? [])
          .map((row) => [row.user_id as string, (row.display_name as string | null)?.trim() ?? ""])
          .filter((row): row is [string, string] => Boolean(row[0]) && Boolean(row[1]))
      );
    }
  }
  if (channelOptions.length > 0) {
    const channelsRes = await supabase.from("chat_channels").select("id, name").eq("org_id", orgId).in("id", channelOptions);
    if (!channelsRes.error) {
      channelNameById = new Map(
        (channelsRes.data ?? [])
          .map((row) => [row.id as string, (row.name as string | null)?.trim() ?? ""])
          .filter((row): row is [string, string] => Boolean(row[0]) && Boolean(row[1]))
      );
    }
  }
  const doneCount = rows.filter((r) => r.execution_status === "done").length;
  const failedCount = rows.filter((r) => r.execution_status === "failed").length;
  const declinedCount = rows.filter((r) => r.execution_status === "declined").length;
  const skippedCount = rows.filter((r) => r.execution_status === "skipped").length;
  const incidentBlockedCount = allRows.filter((row) => {
    const meta = asObject(row.metadata_json);
    return meta?.blocked_by_incident === true;
  }).length;
  const successRate = rows.length > 0 ? Math.round((doneCount / rows.length) * 100) : 0;
  const exportParams = new URLSearchParams();
  exportParams.set("window", windowFilter);
  exportParams.set("from", fromDate.toISOString());
  exportParams.set("to", toDate.toISOString());
  if (source !== "all") exportParams.set("source", source);
  if (status !== "all") exportParams.set("status", status);
  if (requester !== "all") exportParams.set("requester", requester);
  if (scope !== "all") exportParams.set("scope", scope);
  if (intent !== "all") exportParams.set("intent", intent);
  if (channel !== "all") exportParams.set("channel", channel);
  if (incident !== "all") exportParams.set("incident", incident);
  if (sessionId) exportParams.set("session_id", sessionId);
  const focusedChannelName = channel !== "all" ? (channelNameById.get(channel) ?? "名称未設定チャンネル") : null;
  const clearChannelParams = new URLSearchParams();
  clearChannelParams.set("window", windowFilter);
  clearChannelParams.set("from", fromDate.toISOString().slice(0, 16));
  clearChannelParams.set("to", toDate.toISOString().slice(0, 16));
  clearChannelParams.set("source", source);
  clearChannelParams.set("status", status);
  clearChannelParams.set("requester", requester);
  clearChannelParams.set("scope", scope);
  clearChannelParams.set("intent", intent);
  clearChannelParams.set("channel", "all");
  clearChannelParams.set("incident", incident);
  if (sessionId) clearChannelParams.set("session_id", sessionId);
  const activeFilterSummary = [
    status !== "all" ? `状態=${statusLabel(status)}` : null,
    source !== "all" ? `起点=${sourceLabel(source)}` : null,
    requester !== "all" ? `依頼元=${requesterNameById.get(requester) ?? "表示名未設定メンバー"}` : null,
    scope !== "all" ? `スコープ=${scopeLabel(scope)}` : null,
    intent !== "all" ? `意図=${intentLabel(intent)}` : null,
    channel !== "all" ? `チャンネル=${channelNameById.get(channel) ?? "名称未設定チャンネル"}` : null,
    incident !== "all" ? "インシデント=停止のみ" : null,
    sessionId ? `セッション=${sessionId}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const hasActiveExportFilters = activeFilterSummary.length > 0;
  const currentFilterParams = new URLSearchParams();
  currentFilterParams.set("window", windowFilter);
  currentFilterParams.set("from", fromDate.toISOString().slice(0, 16));
  currentFilterParams.set("to", toDate.toISOString().slice(0, 16));
  currentFilterParams.set("source", source);
  currentFilterParams.set("status", status);
  currentFilterParams.set("requester", requester);
  currentFilterParams.set("scope", scope);
  currentFilterParams.set("intent", intent);
  currentFilterParams.set("channel", channel);
  currentFilterParams.set("incident", incident);
  if (sessionId) currentFilterParams.set("session_id", sessionId);
  const currentFilterPath = `/app/executions?${currentFilterParams.toString()}`;

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">AI実行履歴</h1>
        <p className="mt-2 text-sm text-slate-600">ワークスペース全体のAI実行を、チャンネル所属に関係なく監査できます。</p>
      </header>
      {focusedChannelName ? (
        <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
          <p className="text-xs font-semibold text-sky-900">チャンネル絞り込み中</p>
          <p className="mt-1 text-sm text-sky-800">対象: {focusedChannelName}</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Link href={`/app/chat/channels/${channel}`} className="rounded-md border border-sky-300 px-2 py-1 text-sky-700 hover:bg-sky-100">
              チャンネルへ戻る
            </Link>
            <Link href={`/app/executions?${clearChannelParams.toString()}`} className="rounded-md border border-sky-300 px-2 py-1 text-sky-700 hover:bg-sky-100">
              チャンネル絞り込みを解除
            </Link>
          </div>
        </section>
      ) : null}

      <form className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-2 md:grid-cols-10">
          <select name="window" defaultValue={windowFilter} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="24h">期間: 24時間</option>
            <option value="7d">期間: 7日</option>
            <option value="30d">期間: 30日</option>
          </select>
          <input type="datetime-local" name="from" defaultValue={fromDate.toISOString().slice(0, 16)} className="rounded-md border border-slate-300 px-2 py-2 text-xs" />
          <input type="datetime-local" name="to" defaultValue={toDate.toISOString().slice(0, 16)} className="rounded-md border border-slate-300 px-2 py-2 text-xs" />
          <select name="source" defaultValue={source} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">起点: すべて</option>
            <option value="chat">起点: チャット</option>
            <option value="slack">起点: Slack</option>
            <option value="planner">起点: プランナー</option>
          </select>
          <select name="status" defaultValue={status} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">状態: すべて</option>
            <option value="done">状態: 成功</option>
            <option value="failed">状態: 失敗</option>
            <option value="declined">状態: 却下</option>
            <option value="skipped">状態: スキップ</option>
          </select>
          <select name="scope" defaultValue={scope} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">スコープ: すべて</option>
            <option value="shared">スコープ: 共有</option>
            <option value="personal">スコープ: 個人</option>
            <option value="channel">スコープ: チャンネル</option>
          </select>
          <select name="requester" defaultValue={requester} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">依頼元: すべて</option>
            {requesterOptions.map((uid) => (
              <option key={uid} value={uid}>
                {requesterNameById.get(uid) ?? "表示名未設定メンバー"}
              </option>
            ))}
          </select>
          <select name="intent" defaultValue={intent} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">意図: すべて</option>
            {intentOptions.map((item) => (
              <option key={item} value={item}>
                {intentLabel(item)}
              </option>
            ))}
          </select>
          <select name="channel" defaultValue={channel} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">チャンネル: すべて</option>
            {channelOptions.map((id) => (
              <option key={id} value={id}>
                {channelNameById.get(id) ?? "名称未設定チャンネル"}
              </option>
            ))}
          </select>
          <select name="incident" defaultValue={incident} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="all">インシデント: すべて</option>
            <option value="blocked">インシデント: 停止のみ</option>
          </select>
          <input
            type="text"
            name="session_id"
            defaultValue={sessionId}
            placeholder="セッションID"
            className="rounded-md border border-slate-300 px-2 py-2 text-xs"
          />
        </div>
        <button type="submit" className="mt-2 rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800">
          絞り込み
        </button>
        <Link
          href={`/api/executions/export?${exportParams.toString()}`}
          className="ml-2 inline-flex rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
        >
          CSV出力
        </Link>
        <span className="ml-2 inline-flex">
          <CopyFilterLinkButton path={currentFilterPath} />
        </span>
        {hasActiveExportFilters ? (
          <span className="ml-2 inline-flex rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
            条件付きエクスポート
          </span>
        ) : null}
        {hasActiveExportFilters ? (
          <p className="mt-2 text-xs text-slate-600">{activeFilterSummary}</p>
        ) : null}
      </form>
      {sessionId ? (
        <section className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-800">
          セッション固定表示中: {sessionId}
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-7">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">合計</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{rows.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs text-emerald-700">成功</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{doneCount}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-xs text-rose-700">失敗</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{failedCount}</p>
        </div>
        <div className="rounded-xl border border-slate-300 bg-slate-100 p-4">
          <p className="text-xs text-slate-700">却下</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{declinedCount}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs text-slate-700">スキップ</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{skippedCount}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-700">成功率</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{successRate}%</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-xs text-rose-700">インシデント停止</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{incidentBlockedCount}</p>
          <p className="text-[11px] text-rose-700">期間={windowLabel}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">該当する実行履歴はありません。</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => {
              const meta = asObject(row.metadata_json);
              const blockedByIncident = meta?.blocked_by_incident === true;
              const incidentSeverity =
                typeof meta?.incident_severity === "string" ? meta.incident_severity : null;
              const recoveryPath = getRecoveryPath(meta?.recovery_path);
              const recoveryHref = recoveryPath
                ? withRefContext(recoveryPath, {
                    from: "executions",
                    intent: row.intent_type,
                    ts: row.created_at
                  })
                : null;
              return (
              <li key={row.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded-full border px-2 py-0.5 ${statusBadgeClass(row.execution_status)}`}>{statusLabel(row.execution_status)}</span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{sourceLabel(row.source)}</span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{scopeLabel(row.session_scope)}</span>
                  {blockedByIncident ? (
                    <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-rose-800">
                      インシデント停止{incidentSeverity ? `:${incidentSeverity}` : ""}
                    </span>
                  ) : null}
                  <span className="text-slate-500">{new Date(row.created_at).toLocaleString("ja-JP")}</span>
                </div>
                <p className="mt-1 text-sm text-slate-800">{row.summary_text ?? intentLabel(row.intent_type) ?? "実行"}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  依頼元: {row.triggered_by_user_id ? (requesterNameById.get(row.triggered_by_user_id) ?? "表示名未設定メンバー") : "システム"} | 意図:{" "}
                  {intentLabel(row.intent_type)} | 参照: {executionRefLabel(row.execution_ref_type)}
                  {row.channel_id ? ` | チャンネル: ${channelNameById.get(row.channel_id) ?? "名称未設定チャンネル"}` : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {recoveryHref ? (
                    <Link href={recoveryHref} className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-rose-700 hover:bg-rose-100">
                      復旧先を開く
                    </Link>
                  ) : null}
                  <Link href={`/app/executions/${row.id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
                    詳細
                  </Link>
                  {row.execution_ref_type === "task" && row.execution_ref_id ? (
                    <Link href={`/app/tasks/${row.execution_ref_id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
                      タスクへ
                    </Link>
                  ) : null}
                  {row.execution_ref_type === "task" && row.execution_ref_id ? (
                    <Link href={`/app/tasks/${row.execution_ref_id}/evidence?execution_id=${row.id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
                      証跡
                    </Link>
                  ) : null}
                  {row.session_id ? (
                    <Link href={`/app/chat/audit?session_id=${row.session_id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
                      チャット監査
                    </Link>
                  ) : null}
                  {row.session_scope === "channel" && row.channel_id ? (
                    <Link href={`/app/chat/channels/${row.channel_id}`} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
                      チャンネルへ
                    </Link>
                  ) : null}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-600">メタデータ</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">{toRedactedJson(row.metadata_json ?? {})}</pre>
                </details>
              </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
