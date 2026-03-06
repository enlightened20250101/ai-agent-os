import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import {
  createCaseFromExternalEvent,
  runExternalEventAutoTriage,
  runHighPriorityAutoCaseify,
  updateExternalEventStatus
} from "@/app/app/events/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type EventsPageProps = {
  searchParams?: Promise<{
    status?: string;
    provider?: string;
    source?: string;
    priority?: string;
    from?: string;
    to?: string;
    q?: string;
    ok?: string;
    error?: string;
    ref_job?: string;
    ref_ts?: string;
  }>;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function providerLabel(provider: string) {
  if (provider === "google") return "Google";
  if (provider === "gmail") return "Gmail";
  if (provider === "slack") return "Slack";
  if (provider === "system") return "System";
  if (provider === "webhook") return "Webhook";
  return provider;
}

function priorityLabel(priority: string) {
  if (priority === "urgent") return "緊急";
  if (priority === "high") return "高";
  if (priority === "normal") return "通常";
  if (priority === "low") return "低";
  return priority;
}

function priorityBadgeClass(priority: string) {
  if (priority === "urgent") return "border-rose-300 bg-rose-50 text-rose-700";
  if (priority === "high") return "border-amber-300 bg-amber-50 text-amber-700";
  if (priority === "low") return "border-slate-300 bg-slate-50 text-slate-600";
  return "border-sky-300 bg-sky-50 text-sky-700";
}

function isMissingColumnError(message: string, columnName: string) {
  return (
    message.includes(`Could not find the '${columnName}' column`) ||
    message.includes(`column external_events.${columnName} does not exist`)
  );
}

function statusLabel(status: string) {
  if (status === "new") return "未処理";
  if (status === "processed") return "処理済み";
  if (status === "ignored") return "無視";
  if (status === "failed") return "失敗";
  return status;
}

export default async function EventsPage({ searchParams }: EventsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const status = sp.status === "new" || sp.status === "processed" || sp.status === "ignored" || sp.status === "failed" ? sp.status : "all";
  const provider =
    sp.provider === "gmail" || sp.provider === "google" || sp.provider === "slack" || sp.provider === "system" || sp.provider === "webhook"
      ? sp.provider
      : "all";
  const source =
    sp.source === "api" || sp.source === "slack" || sp.source === "gmail" || sp.source === "system" || sp.source === "webhook"
      ? sp.source
      : "all";
  const priority =
    sp.priority === "low" || sp.priority === "normal" || sp.priority === "high" || sp.priority === "urgent"
      ? sp.priority
      : "all";
  const from = typeof sp.from === "string" ? sp.from : "";
  const to = typeof sp.to === "string" ? sp.to : "";
  const keyword = typeof sp.q === "string" ? sp.q.trim() : "";
  const refJob = typeof sp.ref_job === "string" ? sp.ref_job : "";
  const refTs = typeof sp.ref_ts === "string" ? sp.ref_ts : "";

  let query = supabase
    .from("external_events")
    .select(
      "id, provider, source, priority, triage_note, triaged_at, linked_case_id, event_type, external_event_id, summary_text, payload_json, status, occurred_at, processed_at, created_at"
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (status !== "all") query = query.eq("status", status);
  if (provider !== "all") query = query.eq("provider", provider);
  if (source !== "all") query = query.eq("source", source);
  if (priority !== "all") query = query.eq("priority", priority);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  let { data, error } = await query;
  if (error && isMissingColumnError(error.message, "priority")) {
    let fallbackQuery = supabase
      .from("external_events")
      .select("id, provider, source, event_type, external_event_id, summary_text, payload_json, status, occurred_at, processed_at, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (status !== "all") fallbackQuery = fallbackQuery.eq("status", status);
    if (provider !== "all") fallbackQuery = fallbackQuery.eq("provider", provider);
    if (source !== "all") fallbackQuery = fallbackQuery.eq("source", source);
    if (from) fallbackQuery = fallbackQuery.gte("created_at", from);
    if (to) fallbackQuery = fallbackQuery.lte("created_at", to);
    const fallback = await fallbackQuery;
    data = (fallback.data ?? []).map((row) => ({
      ...row,
      priority: "normal",
      triage_note: null,
      triaged_at: null,
      linked_case_id: null
    }));
    error = fallback.error;
  }
  if (error) {
    if (isMissingTableError(error.message, "external_events")) {
      return (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          `external_events` migration 未適用です。`supabase db push` を実行してください。
        </section>
      );
    }
    throw new Error(`Failed to load external events: ${error.message}`);
  }

  const rows = (data ?? []).filter((row) => {
    if (!keyword) return true;
    const target = `${row.event_type ?? ""} ${row.summary_text ?? ""} ${row.external_event_id ?? ""}`.toLowerCase();
    return target.includes(keyword.toLowerCase());
  });
  const highlightedEventId = (() => {
    if (refTs) {
      const exact = rows.find((row) => String(row.created_at ?? "") === refTs);
      if (exact?.id) return String(exact.id);
    }
    if (refJob === "events_auto_caseify") {
      const candidate = rows.find(
        (row) =>
          row.status === "new" &&
          (String(row.priority ?? "") === "high" || String(row.priority ?? "") === "urgent")
      );
      if (candidate?.id) return String(candidate.id);
    }
    return null;
  })();
  const countNew = rows.filter((row) => row.status === "new").length;
  const countProcessed = rows.filter((row) => row.status === "processed").length;
  const linkedCaseIds = Array.from(
    new Set(
      rows
        .map((row) => (typeof row.linked_case_id === "string" ? row.linked_case_id : null))
        .filter((value): value is string => Boolean(value))
    )
  );
  let caseTitleById = new Map<string, string>();
  if (linkedCaseIds.length > 0) {
    const casesRes = await supabase.from("business_cases").select("id, title").eq("org_id", orgId).in("id", linkedCaseIds);
    if (!casesRes.error) {
      caseTitleById = new Map(
        (casesRes.data ?? [])
          .map((row) => [row.id as string, (row.title as string | null) ?? "案件"])
          .filter((item): item is [string, string] => Boolean(item[0]))
      );
    }
  }

  const exportParams = new URLSearchParams();
  if (status !== "all") exportParams.set("status", status);
  if (provider !== "all") exportParams.set("provider", provider);
  if (source !== "all") exportParams.set("source", source);
  if (priority !== "all") exportParams.set("priority", priority);
  if (from) exportParams.set("from", from);
  if (to) exportParams.set("to", to);
  if (keyword) exportParams.set("q", keyword);
  const exportHref = `/api/events/export${exportParams.size > 0 ? `?${exportParams.toString()}` : ""}`;
  const hasActiveFilters =
    status !== "all" || provider !== "all" || source !== "all" || priority !== "all" || Boolean(from || to || keyword);
  const currentFilterParams = new URLSearchParams();
  currentFilterParams.set("status", status);
  currentFilterParams.set("provider", provider);
  currentFilterParams.set("source", source);
  currentFilterParams.set("priority", priority);
  if (from) currentFilterParams.set("from", from);
  if (to) currentFilterParams.set("to", to);
  if (keyword) currentFilterParams.set("q", keyword);
  const currentFilterPath = `/app/events?${currentFilterParams.toString()}`;
  const activeFilterSummary = [
    status !== "all" ? `状態=${statusLabel(status)}` : null,
    provider !== "all" ? `プロバイダ=${providerLabel(provider)}` : null,
    source !== "all" ? `source=${source}` : null,
    priority !== "all" ? `優先度=${priorityLabel(priority)}` : null,
    from ? `from=${from}` : null,
    to ? `to=${to}` : null,
    keyword ? `キーワード=${keyword}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">外部イベント</h1>
        <p className="mt-2 text-sm text-slate-600">
          外部システムから取り込んだイベントの台帳です。monitor/planner の自律提案トリガーに使われます。
        </p>
        <StatusNotice ok={sp.ok} error={sp.error} className="mt-3" />
        {refJob ? (
          <div className="mt-3 rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
            参照元: {refJob}
            {refTs ? ` / ${new Date(refTs).toLocaleString("ja-JP")}` : ""}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Link href="/app/monitor" className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
            監視へ
          </Link>
          <Link href="/app/planner" className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
            プランナーへ
          </Link>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">表示件数</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{rows.length}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-700">未処理</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{countNew}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs text-emerald-700">処理済み</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{countProcessed}</p>
        </div>
      </section>

      <details open={hasActiveFilters} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <summary className="cursor-pointer list-none text-sm font-semibold text-slate-800">
          絞り込み・出力
        </summary>
        <form method="get" className="mt-3">
          <div className="grid gap-2 md:grid-cols-7">
            <select name="status" defaultValue={status} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
              <option value="all">状態: すべて</option>
              <option value="new">状態: 未処理</option>
              <option value="processed">状態: 処理済み</option>
              <option value="ignored">状態: 無視</option>
              <option value="failed">状態: 失敗</option>
            </select>
            <select name="provider" defaultValue={provider} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
              <option value="all">プロバイダ: すべて</option>
              <option value="gmail">Gmail</option>
              <option value="google">Google</option>
              <option value="slack">Slack</option>
              <option value="system">System</option>
              <option value="webhook">Webhook</option>
            </select>
            <select name="source" defaultValue={source} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
              <option value="all">source: すべて</option>
              <option value="api">api</option>
              <option value="slack">slack</option>
              <option value="gmail">gmail</option>
              <option value="system">system</option>
              <option value="webhook">webhook</option>
            </select>
            <select name="priority" defaultValue={priority} className="rounded-md border border-slate-300 px-2 py-2 text-xs">
              <option value="all">優先度: すべて</option>
              <option value="urgent">緊急</option>
              <option value="high">高</option>
              <option value="normal">通常</option>
              <option value="low">低</option>
            </select>
            <input
              type="datetime-local"
              name="from"
              defaultValue={from}
              className="rounded-md border border-slate-300 px-2 py-2 text-xs"
              placeholder="from"
            />
            <input
              type="datetime-local"
              name="to"
              defaultValue={to}
              className="rounded-md border border-slate-300 px-2 py-2 text-xs"
              placeholder="to"
            />
            <input
              type="text"
              name="q"
              defaultValue={keyword}
              className="rounded-md border border-slate-300 px-2 py-2 text-xs"
              placeholder="キーワード(event_type/summary/external_id)"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800">
              絞り込み
            </button>
            <a href={exportHref} className="rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50">
              CSV出力
            </a>
            <CopyFilterLinkButton path={currentFilterPath} />
            {hasActiveFilters ? (
              <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                条件付きエクスポート
              </span>
            ) : null}
          </div>
          {hasActiveFilters ? <p className="mt-2 text-xs text-slate-600">{activeFilterSummary}</p> : null}
        </form>
      </details>
      <form action={runExternalEventAutoTriage} className="-mt-3">
        <input type="hidden" name="return_to" value={currentFilterPath} />
        <input type="hidden" name="status" value={status} />
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="source" value={source} />
        <input type="hidden" name="priority" value={priority} />
        <input type="hidden" name="from" value={from} />
        <input type="hidden" name="to" value={to} />
        <input type="hidden" name="q" value={keyword} />
        <ConfirmSubmitButton
          label="未処理を自動仕分け"
          pendingLabel="仕分け中..."
          confirmMessage="未処理イベントの優先度を自動判定します。実行しますか？"
          className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-xs text-indigo-800 hover:bg-indigo-100"
        />
      </form>
      <form action={runHighPriorityAutoCaseify} className="-mt-2">
        <input type="hidden" name="return_to" value={currentFilterPath} />
        <input type="hidden" name="status" value={status} />
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="source" value={source} />
        <input type="hidden" name="priority" value={priority} />
        <input type="hidden" name="from" value={from} />
        <input type="hidden" name="to" value={to} />
        <input type="hidden" name="q" value={keyword} />
        <ConfirmSubmitButton
          label="高優先度を自動Case化"
          pendingLabel="Case化中..."
          confirmMessage="priority=high/urgent の未処理イベントを自動でCase化します。実行しますか？"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 hover:bg-rose-100"
        />
      </form>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">該当する外部イベントはありません。</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => {
              const rowId = String(row.id ?? "");
              const isRef = highlightedEventId !== null && rowId === highlightedEventId;
              return (
              <li key={row.id as string} className={`rounded-lg border p-3 ${isRef ? "border-indigo-300 bg-indigo-50/40" : "border-slate-200"}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{providerLabel(row.provider as string)}</span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">source:{(row.source as string) ?? "api"}</span>
                  <span className={`rounded-full border px-2 py-0.5 ${priorityBadgeClass((row.priority as string | null) ?? "normal")}`}>
                    優先度:{priorityLabel((row.priority as string | null) ?? "normal")}
                  </span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">{statusLabel(row.status as string)}</span>
                  <span className="text-slate-500">{new Date(row.created_at as string).toLocaleString("ja-JP")}</span>
                </div>
                <p className="mt-1 text-sm text-slate-800">{(row.summary_text as string | null) ?? (row.event_type as string)}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  event_type: {row.event_type as string}
                  {(row.external_event_id as string | null) ? ` | external_id: ${row.external_event_id as string}` : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {typeof row.linked_case_id === "string" && row.linked_case_id.length > 0 ? (
                    <Link
                      href={`/app/cases/${row.linked_case_id as string}`}
                      className="rounded-md border border-indigo-300 px-2 py-1 text-indigo-700 hover:bg-indigo-50"
                    >
                      Case: {caseTitleById.get(row.linked_case_id as string) ?? "詳細へ"}
                    </Link>
                  ) : (
                    <form action={createCaseFromExternalEvent}>
                      <input type="hidden" name="event_id" value={row.id as string} />
                      <input type="hidden" name="return_to" value={currentFilterPath} />
                      <input type="hidden" name="status" value={status} />
                      <input type="hidden" name="provider" value={provider} />
                      <input type="hidden" name="source" value={source} />
                      <input type="hidden" name="priority" value={priority} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="to" value={to} />
                      <input type="hidden" name="q" value={keyword} />
                      <ConfirmSubmitButton
                        label="Case化"
                        pendingLabel="起票中..."
                        confirmMessage="この外部イベントからCaseを起票します。実行しますか？"
                        className="rounded-md border border-indigo-300 px-2 py-1 text-indigo-700 hover:bg-indigo-50"
                      />
                    </form>
                  )}
                  {(row.status as string) !== "processed" ? (
                    <form action={updateExternalEventStatus}>
                      <input type="hidden" name="event_id" value={row.id as string} />
                      <input type="hidden" name="to_status" value="processed" />
                      <input type="hidden" name="return_to" value={currentFilterPath} />
                      <input type="hidden" name="status" value={status} />
                      <input type="hidden" name="provider" value={provider} />
                      <input type="hidden" name="source" value={source} />
                      <input type="hidden" name="priority" value={priority} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="to" value={to} />
                      <input type="hidden" name="q" value={keyword} />
                      <ConfirmSubmitButton
                        label="処理済みにする"
                        pendingLabel="更新中..."
                        confirmMessage="このイベントを処理済みにします。よろしいですか？"
                        className="rounded-md border border-emerald-300 px-2 py-1 text-emerald-700 hover:bg-emerald-50"
                      />
                    </form>
                  ) : null}
                  {(row.status as string) !== "ignored" ? (
                    <form action={updateExternalEventStatus}>
                      <input type="hidden" name="event_id" value={row.id as string} />
                      <input type="hidden" name="to_status" value="ignored" />
                      <input type="hidden" name="return_to" value={currentFilterPath} />
                      <input type="hidden" name="status" value={status} />
                      <input type="hidden" name="provider" value={provider} />
                      <input type="hidden" name="source" value={source} />
                      <input type="hidden" name="priority" value={priority} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="to" value={to} />
                      <input type="hidden" name="q" value={keyword} />
                      <ConfirmSubmitButton
                        label="無視にする"
                        pendingLabel="更新中..."
                        confirmMessage="このイベントを無視状態にします。よろしいですか？"
                        className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
                      />
                    </form>
                  ) : null}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-600">payload JSON</summary>
                  {(row.triage_note as string | null) ? (
                    <p className="mt-1 text-[11px] text-indigo-700">
                      triage: {row.triage_note as string}
                      {(row.triaged_at as string | null)
                        ? ` (${new Date(row.triaged_at as string).toLocaleString("ja-JP")})`
                        : ""}
                    </p>
                  ) : null}
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                    {toRedactedJson(row.payload_json ?? {})}
                  </pre>
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
