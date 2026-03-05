import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import {
  decideApproval,
  resendApprovalSlackReminder,
  sendStaleApprovalRemindersNow
} from "@/app/app/approvals/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ApprovalsPageProps = {
  searchParams?: Promise<{ error?: string; ok?: string; stale_only?: string; sort?: string }>;
};

type ApprovalRow = {
  id: string;
  task_id: string;
  status: string;
  created_at: string;
  reason: string | null;
};

export default async function ApprovalsPage({ searchParams }: ApprovalsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleHours = Number(process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6");
  const staleOnly = sp.stale_only === "1";
  const sort = sp.sort === "newest" ? "newest" : "oldest";

  const [{ data: approvals, error }, { data: weeklyApprovals, error: weeklyError }] = await Promise.all([
    supabase
      .from("approvals")
      .select("id, task_id, status, created_at, reason")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("approvals")
      .select("id, status, created_at")
      .eq("org_id", orgId)
      .gte("created_at", sevenDaysAgoIso)
      .order("created_at", { ascending: false })
      .limit(500)
  ]);

  if (error) {
    throw new Error(`Failed to load approvals: ${error.message}`);
  }
  if (weeklyError) {
    throw new Error(`Failed to load weekly approvals: ${weeklyError.message}`);
  }

  const pendingApprovals = (approvals ?? []) as ApprovalRow[];
  const filteredApprovals = pendingApprovals
    .filter((approval) => {
      if (!staleOnly) return true;
      const ageHours = (Date.now() - new Date(approval.created_at).getTime()) / (60 * 60 * 1000);
      return ageHours >= staleHours;
    })
    .sort((a, b) => {
      if (sort === "newest") {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  const weeklyRows = weeklyApprovals ?? [];
  const taskIds = filteredApprovals.map((approval) => approval.task_id);
  const approvedCount = weeklyRows.filter((row) => row.status === "approved").length;
  const rejectedCount = weeklyRows.filter((row) => row.status === "rejected").length;
  const pendingCount = weeklyRows.filter((row) => row.status === "pending").length;
  const maxCount = Math.max(1, approvedCount, rejectedCount, pendingCount);

  let taskTitleById = new Map<string, string>();
  if (taskIds.length > 0) {
    const { data: tasks, error: tasksError } = await supabase
      .from("tasks")
      .select("id, title")
      .in("id", taskIds)
      .eq("org_id", orgId);

    if (tasksError) {
      throw new Error(`Failed to load approval tasks: ${tasksError.message}`);
    }

    taskTitleById = new Map<string, string>((tasks ?? []).map((task) => [task.id as string, task.title as string]));
  }

  const chartRows = [
    { key: "approved", label: "approved", count: approvedCount, color: "bg-emerald-500" },
    { key: "rejected", label: "rejected", count: rejectedCount, color: "bg-rose-500" },
    { key: "pending", label: "pending", count: pendingCount, color: "bg-amber-500" }
  ];

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">承認</h1>
      <p className="mt-2 text-sm text-slate-600">組織内の保留中承認です。</p>

      <StatusNotice ok={sp.ok} error={sp.error} className="mt-4" />

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              name="stale_only"
              value="1"
              defaultChecked={staleOnly}
              className="h-4 w-4 rounded border-slate-300"
            />
            SLA超過のみ
          </label>
          <label className="inline-flex items-center gap-2">
            並び順
            <select name="sort" defaultValue={sort} className="rounded-md border border-slate-300 px-2 py-1">
              <option value="oldest">古い順</option>
              <option value="newest">新しい順</option>
            </select>
          </label>
          <button type="submit" className="rounded-md border border-slate-300 bg-white px-2 py-1">
            適用
          </button>
        </form>
        <form action={sendStaleApprovalRemindersNow}>
          <ConfirmSubmitButton
            label="SLA超過をSlack再通知"
            pendingLabel="再通知中..."
            confirmMessage="SLA超過の承認待ちをSlackへ再通知します。実行しますか？"
            className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-sky-700 hover:bg-sky-100"
          />
        </form>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">7日 pending</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{pendingCount}</p>
        </div>
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">7日 approved</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{approvedCount}</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${rejectedCount > 0 ? "border-rose-300 bg-rose-100" : "border-rose-200 bg-rose-50"}`}>
          <p className="text-rose-700">7日 rejected</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{rejectedCount}</p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">7日ステータス分布（縦棒）</p>
          <span className="text-xs text-slate-500">0件は棒なし</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {chartRows.map((row) => {
            const heightPct = row.count > 0 ? Math.max(16, Math.round((row.count / maxCount) * 100)) : 0;
            return (
              <div key={row.key} className="rounded-lg border border-slate-100 bg-white p-3">
                <div className="flex h-36 items-end justify-center rounded-md bg-slate-50">
                  {row.count > 0 ? <div className={`w-10 rounded-t-md ${row.color}`} style={{ height: `${heightPct}%` }} /> : null}
                </div>
                <p className="mt-2 text-center font-mono text-xs text-slate-600">{row.label}</p>
                <p className="text-center text-sm font-semibold text-slate-900">{row.count}</p>
              </div>
            );
          })}
        </div>
      </div>

      {filteredApprovals.length > 0 ? (
        <ul className="mt-5 space-y-4">
          {filteredApprovals.map((approval) => (
            <li key={approval.id} className="rounded-md border border-amber-200 bg-amber-50/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-700">
                  タスク:{" "}
                  <Link href={`/app/tasks/${approval.task_id}`} className="font-medium">
                    {taskTitleById.get(approval.task_id) ?? approval.task_id}
                  </Link>
                </p>
                <p className="text-xs text-slate-500">依頼日時 {new Date(approval.created_at).toLocaleString()}</p>
                {(() => {
                  const ageHours = Math.floor((Date.now() - new Date(approval.created_at).getTime()) / (60 * 60 * 1000));
                  const isStale = ageHours >= staleHours;
                  return (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        isStale ? "border-rose-300 bg-rose-50 text-rose-700" : "border-slate-300 bg-slate-50 text-slate-600"
                      }`}
                    >
                      経過 {ageHours}h {isStale ? "(SLA超過)" : ""}
                    </span>
                  );
                })()}
              </div>

              <form action={decideApproval} className="mt-3 flex flex-col gap-3 md:flex-row md:items-center">
                <input type="hidden" name="approval_id" value={approval.id} />
                <input
                  type="text"
                  name="reason"
                  placeholder="理由（任意）"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm md:max-w-md"
                />
                <div className="flex gap-2">
                  <ConfirmSubmitButton
                    name="decision"
                    value="approved"
                    label="承認"
                    pendingLabel="処理中..."
                    confirmMessage="この承認を approved に更新します。実行しますか？"
                    className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600"
                  />
                  <ConfirmSubmitButton
                    name="decision"
                    value="rejected"
                    label="却下"
                    pendingLabel="処理中..."
                    confirmMessage="この承認を rejected に更新します。実行しますか？"
                    className="rounded-md bg-rose-700 px-3 py-2 text-sm text-white hover:bg-rose-600"
                  />
                </div>
              </form>
              <form action={resendApprovalSlackReminder} className="mt-2">
                <input type="hidden" name="approval_id" value={approval.id} />
                <ConfirmSubmitButton
                  label="Slackに再通知"
                  pendingLabel="再通知中..."
                  confirmMessage="この承認依頼をSlackに再通知します。実行しますか？"
                  className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-700 hover:bg-sky-100"
                />
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-slate-600">
          {staleOnly ? `SLA超過（${staleHours}h以上）の保留承認はありません。` : "保留中の承認はありません。"}
        </p>
      )}
    </section>
  );
}
