import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { createCase, syncCaseStagesNow, updateCaseStatus } from "@/app/app/cases/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type CasesPageProps = {
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

type CaseRow = {
  id: string;
  title: string;
  case_type: string;
  status: "open" | "blocked" | "closed";
  stage: string | null;
  source: string;
  owner_user_id: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
};

type CaseEventRow = {
  case_id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function isMissingColumnError(message: string, columnName: string) {
  return message.includes(`column ${columnName} does not exist`) || message.includes(`Could not find the '${columnName}' column`);
}

function statusBadge(status: CaseRow["status"]) {
  if (status === "blocked") return "border-rose-300 bg-rose-50 text-rose-700";
  if (status === "closed") return "border-slate-300 bg-slate-100 text-slate-700";
  return "border-emerald-300 bg-emerald-50 text-emerald-700";
}

function stageBadge(stage: string | null) {
  if (stage === "blocked") return "border-rose-300 bg-rose-50 text-rose-700";
  if (stage === "exception") return "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700";
  if (stage === "awaiting_approval") return "border-amber-300 bg-amber-50 text-amber-700";
  if (stage === "executing") return "border-sky-300 bg-sky-50 text-sky-700";
  if (stage === "approved") return "border-emerald-300 bg-emerald-50 text-emerald-700";
  if (stage === "completed") return "border-slate-300 bg-slate-100 text-slate-700";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

export default async function CasesPage({ searchParams }: CasesPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const params = searchParams ? await searchParams : {};
  const staleCaseHours = Number(process.env.CASE_STALE_HOURS ?? "48");
  const staleCaseCutoffIso = new Date(Date.now() - staleCaseHours * 60 * 60 * 1000).toISOString();

  const statusFilter =
    params.status === "open" || params.status === "blocked" || params.status === "closed" ? params.status : "all";
  const refJob = typeof params.ref_job === "string" ? params.ref_job : "";
  const refTs = typeof params.ref_ts === "string" ? params.ref_ts : "";
  const refFrom = typeof params.ref_from === "string" ? params.ref_from : "";
  const refIntent = typeof params.ref_intent === "string" ? params.ref_intent : "";

  const casesResBase = supabase
    .from("business_cases")
    .select("id, title, case_type, status, stage, source, owner_user_id, due_at, created_at, updated_at")
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false });

  const casesRes = statusFilter === "all" ? await casesResBase : await casesResBase.eq("status", statusFilter);
  let caseRowsData = (casesRes.data ?? []) as Array<Record<string, unknown>>;
  let casesError = casesRes.error;
  if (casesError && (isMissingColumnError(casesError.message, "owner_user_id") || isMissingColumnError(casesError.message, "stage"))) {
    const fallbackBase = supabase
      .from("business_cases")
      .select("id, title, case_type, status, source, created_at, updated_at")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false });
    const fallbackRes = statusFilter === "all" ? await fallbackBase : await fallbackBase.eq("status", statusFilter);
    caseRowsData = (fallbackRes.data ?? []).map((row) => ({
      ...row,
      owner_user_id: null,
      due_at: null,
      stage: (row.status as string) === "closed" ? "completed" : (row.status as string) === "blocked" ? "blocked" : "intake"
    }));
    casesError = fallbackRes.error;
  }

  if (casesError) {
    if (isMissingTableError(casesError.message, "business_cases")) {
      return (
        <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h1 className="text-xl font-semibold text-amber-900">案件台帳</h1>
          <p className="text-sm text-amber-800">
            `business_cases` テーブルがまだありません。`supabase db push` を実行して migration を適用してください。
          </p>
        </section>
      );
    }
    throw new Error(`Failed to load cases: ${casesError.message}`);
  }

  const rows = caseRowsData as CaseRow[];
  const caseIds = rows.map((row) => row.id);
  const ownerUserIds = Array.from(new Set(rows.map((row) => row.owner_user_id).filter((v): v is string => Boolean(v))));
  const taskCountByCaseId = new Map<string, number>();
  const recentEventsByCaseId = new Map<string, CaseEventRow[]>();
  let ownerNameByUserId = new Map<string, string>();
  if (ownerUserIds.length > 0) {
    const profilesRes = await supabase.from("user_profiles").select("user_id, display_name").eq("org_id", orgId).in("user_id", ownerUserIds);
    if (!profilesRes.error) {
      ownerNameByUserId = new Map(
        (profilesRes.data ?? [])
          .map((row) => [row.user_id as string, (row.display_name as string | null)?.trim() ?? ""])
          .filter((row): row is [string, string] => Boolean(row[0]) && Boolean(row[1]))
      );
    }
  }
  if (caseIds.length > 0) {
    const [countRes, caseEventsRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("case_id")
        .eq("org_id", orgId)
        .in("case_id", caseIds),
      supabase
        .from("case_events")
        .select("case_id, event_type, created_at, payload_json")
        .eq("org_id", orgId)
        .in("case_id", caseIds)
        .order("created_at", { ascending: false })
        .limit(120)
    ]);
    if (!countRes.error) {
      for (const row of countRes.data ?? []) {
        const caseId = row.case_id as string | null;
        if (!caseId) continue;
        taskCountByCaseId.set(caseId, (taskCountByCaseId.get(caseId) ?? 0) + 1);
      }
    }
    if (!caseEventsRes.error) {
      for (const raw of (caseEventsRes.data ?? []) as CaseEventRow[]) {
        const list = recentEventsByCaseId.get(raw.case_id) ?? [];
        if (list.length < 5) {
          list.push(raw);
          recentEventsByCaseId.set(raw.case_id, list);
        }
      }
    }
  }

  const openCount = rows.filter((row) => row.status === "open").length;
  const blockedCount = rows.filter((row) => row.status === "blocked").length;
  const closedCount = rows.filter((row) => row.status === "closed").length;
  const enrichedRows = rows
    .map((row) => {
      const isStale = row.status === "open" && row.updated_at < staleCaseCutoffIso;
      const urgencyScore = row.status === "blocked" ? 100 : isStale ? 90 : row.status === "open" ? 60 : 10;
      return { ...row, isStale, urgencyScore };
    })
    .sort((a, b) => {
      if (b.urgencyScore !== a.urgencyScore) return b.urgencyScore - a.urgencyScore;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  const staleCount = enrichedRows.filter((row) => row.isStale).length;
  const stageCounts = new Map<string, number>();
  for (const row of enrichedRows) {
    const key = row.stage ?? "intake";
    stageCounts.set(key, (stageCounts.get(key) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6 shadow-sm">
        <h1 className="text-xl font-semibold">案件台帳（Case Ledger）</h1>
        <p className="mt-2 text-sm text-slate-600">案件を起点に関連タスクをまとめて管理します。</p>
        <StatusNotice ok={params.ok} error={params.error} className="mt-4" />
        {refJob || refTs || refFrom || refIntent ? (
          <p className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            参照コンテキスト: {refJob || refFrom || "manual"}
            {refIntent ? ` / ${refIntent}` : ""}
            {refTs ? ` (${new Date(refTs).toLocaleString("ja-JP")})` : ""}
          </p>
        ) : null}

        <form action={createCase} className="mt-5 grid gap-3 md:grid-cols-4">
          <input
            type="text"
            name="title"
            required
            placeholder="案件タイトル"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm md:col-span-2"
          />
          <input
            type="text"
            name="case_type"
            placeholder="case_type (例: ap_invoice)"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <ConfirmSubmitButton
            label="案件を作成"
            pendingLabel="作成中..."
            confirmMessage="案件を作成します。実行しますか？"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          />
        </form>
        <form action={syncCaseStagesNow} className="mt-3">
          <ConfirmSubmitButton
            label="ケースステージを同期"
            pendingLabel="同期中..."
            confirmMessage="全案件のステージを、紐づくタスク状態から再計算します。実行しますか？"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          />
        </form>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs text-emerald-700">OPEN</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{openCount}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-xs text-rose-700">BLOCKED</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{blockedCount}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-100 p-4">
          <p className="text-xs text-slate-700">CLOSED</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{closedCount}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-medium text-slate-700">Case Stage Distribution</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {["intake", "drafting", "awaiting_approval", "approved", "executing", "exception", "blocked", "completed"].map((stage) => (
            <span key={stage} className={`rounded-full border px-2 py-1 ${stageBadge(stage)}`}>
              {stage}: {stageCounts.get(stage) ?? 0}
            </span>
          ))}
        </div>
      </section>

      {staleCount > 0 ? (
        <section className="rounded-xl border border-rose-300 bg-rose-50 p-4">
          <p className="text-sm font-semibold text-rose-900">滞留案件アラート</p>
          <p className="mt-1 text-xs text-rose-800">
            {staleCaseHours}時間以上更新されていない open 案件が {staleCount} 件あります。
          </p>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
          <span className="font-medium text-slate-700">ステータス</span>
          {(["all", "open", "blocked", "closed"] as const).map((status) => {
            const href = status === "all" ? "/app/cases" : `/app/cases?status=${status}`;
            const selected = statusFilter === status;
            return (
              <Link
                key={status}
                href={href}
                className={`rounded-full border px-2 py-1 ${selected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"}`}
              >
                {status}
              </Link>
            );
          })}
        </div>

        {enrichedRows.length === 0 ? (
          <p className="text-sm text-slate-600">案件はまだありません。</p>
        ) : (
          <ul className="space-y-3">
            {enrichedRows.map((row, index) => {
              const matchesRefTs =
                Boolean(refTs) &&
                (new Date(row.updated_at).toISOString() === new Date(refTs).toISOString() ||
                  new Date(row.created_at).toISOString() === new Date(refTs).toISOString());
              const isAutoCaseifyRef = refJob === "events_auto_caseify";
              const fallbackHighlighted =
                isAutoCaseifyRef && index === 0 && (row.source === "external_event" || row.status === "open");
              const isHighlighted = matchesRefTs || fallbackHighlighted;
              return (
              <li
                key={row.id}
                className={`rounded-lg border p-4 ${isHighlighted ? "border-indigo-300 bg-indigo-50/40 ring-1 ring-indigo-200" : "border-slate-200"}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/app/cases/${row.id}`} className="font-medium text-slate-900 hover:underline">
                    {row.title}
                  </Link>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusBadge(row.status)}`}>{row.status}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${stageBadge(row.stage)}`}>{row.stage ?? "intake"}</span>
                  {row.status === "blocked" ? (
                    <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">緊急</span>
                  ) : row.isStale ? (
                    <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                      滞留 {staleCaseHours}h+
                    </span>
                  ) : null}
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">
                    {row.case_type}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  tasks: {taskCountByCaseId.get(row.id) ?? 0} | owner: {row.owner_user_id ? (ownerNameByUserId.get(row.owner_user_id) ?? "担当者") : "未割当"} | due:{" "}
                  {row.due_at ? new Date(row.due_at).toLocaleString() : "未設定"} | updated: {new Date(row.updated_at).toLocaleString()}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href={`/app/tasks?case_id=${row.id}`}
                    className="rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    この案件のタスクを見る
                  </Link>
                  <form action={updateCaseStatus}>
                    <input type="hidden" name="case_id" value={row.id} />
                    <input type="hidden" name="status" value="open" />
                    <ConfirmSubmitButton
                      label="Open"
                      pendingLabel="更新中..."
                      confirmMessage="案件を open に戻します。よろしいですか？"
                      className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 hover:bg-emerald-100"
                    />
                  </form>
                  <form action={updateCaseStatus}>
                    <input type="hidden" name="case_id" value={row.id} />
                    <input type="hidden" name="status" value="blocked" />
                    <ConfirmSubmitButton
                      label="Blocked"
                      pendingLabel="更新中..."
                      confirmMessage="案件を blocked にします。よろしいですか？"
                      className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 hover:bg-rose-100"
                    />
                  </form>
                  <form action={updateCaseStatus}>
                    <input type="hidden" name="case_id" value={row.id} />
                    <input type="hidden" name="status" value="closed" />
                    <ConfirmSubmitButton
                      label="Closed"
                      pendingLabel="更新中..."
                      confirmMessage="案件を closed にします。よろしいですか？"
                      className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100"
                    />
                  </form>
                </div>
                {recentEventsByCaseId.get(row.id)?.length ? (
                  <details className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                    <summary className="cursor-pointer text-xs font-medium text-slate-700">最近のケースイベント</summary>
                    <ul className="mt-2 space-y-1 text-xs text-slate-600">
                      {(recentEventsByCaseId.get(row.id) ?? []).map((event) => (
                        <li key={`${row.id}-${event.created_at}-${event.event_type}`}>
                          {new Date(event.created_at).toLocaleString()} | {event.event_type}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
