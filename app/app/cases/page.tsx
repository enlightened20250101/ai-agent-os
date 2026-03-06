import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { createCase, updateCaseStatus } from "@/app/app/cases/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type CasesPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string; status?: string }>;
};

type CaseRow = {
  id: string;
  title: string;
  case_type: string;
  status: "open" | "blocked" | "closed";
  source: string;
  created_at: string;
  updated_at: string;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function statusBadge(status: CaseRow["status"]) {
  if (status === "blocked") return "border-rose-300 bg-rose-50 text-rose-700";
  if (status === "closed") return "border-slate-300 bg-slate-100 text-slate-700";
  return "border-emerald-300 bg-emerald-50 text-emerald-700";
}

export default async function CasesPage({ searchParams }: CasesPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const params = searchParams ? await searchParams : {};

  const statusFilter =
    params.status === "open" || params.status === "blocked" || params.status === "closed" ? params.status : "all";

  const casesResBase = supabase
    .from("business_cases")
    .select("id, title, case_type, status, source, created_at, updated_at")
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false });

  const casesRes = statusFilter === "all" ? await casesResBase : await casesResBase.eq("status", statusFilter);

  if (casesRes.error) {
    if (isMissingTableError(casesRes.error.message, "business_cases")) {
      return (
        <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h1 className="text-xl font-semibold text-amber-900">案件台帳</h1>
          <p className="text-sm text-amber-800">
            `business_cases` テーブルがまだありません。`supabase db push` を実行して migration を適用してください。
          </p>
        </section>
      );
    }
    throw new Error(`Failed to load cases: ${casesRes.error.message}`);
  }

  const rows = (casesRes.data ?? []) as CaseRow[];
  const caseIds = rows.map((row) => row.id);
  const taskCountByCaseId = new Map<string, number>();
  if (caseIds.length > 0) {
    const countRes = await supabase
      .from("tasks")
      .select("case_id")
      .eq("org_id", orgId)
      .in("case_id", caseIds);
    if (!countRes.error) {
      for (const row of countRes.data ?? []) {
        const caseId = row.case_id as string | null;
        if (!caseId) continue;
        taskCountByCaseId.set(caseId, (taskCountByCaseId.get(caseId) ?? 0) + 1);
      }
    }
  }

  const openCount = rows.filter((row) => row.status === "open").length;
  const blockedCount = rows.filter((row) => row.status === "blocked").length;
  const closedCount = rows.filter((row) => row.status === "closed").length;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6 shadow-sm">
        <h1 className="text-xl font-semibold">案件台帳（Case Ledger）</h1>
        <p className="mt-2 text-sm text-slate-600">案件を起点に関連タスクをまとめて管理します。</p>
        <StatusNotice ok={params.ok} error={params.error} className="mt-4" />

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

        {rows.length === 0 ? (
          <p className="text-sm text-slate-600">案件はまだありません。</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-slate-900">{row.title}</p>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusBadge(row.status)}`}>{row.status}</span>
                  <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">
                    {row.case_type}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  tasks: {taskCountByCaseId.get(row.id) ?? 0} | updated: {new Date(row.updated_at).toLocaleString()}
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
