import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import {
  decideApproval,
  resendSelectedApprovalSlackReminders,
  resendApprovalSlackReminder,
  runGuardedAutoReminderNow,
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

type ReminderEventRow = {
  task_id: string;
  created_at: string;
  payload_json: unknown;
};

function parseObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export default async function ApprovalsPage({ searchParams }: ApprovalsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleHours = Number(process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6");
  const staleOnly = sp.stale_only === "1";
  const sort = sp.sort === "newest" ? "newest" : "oldest";
  const autoMinStaleRaw = Number.parseInt(process.env.APPROVAL_REMINDER_AUTO_MIN_STALE ?? "3", 10);
  const autoMinStale = Number.isNaN(autoMinStaleRaw) ? 3 : Math.max(1, Math.min(1000, autoMinStaleRaw));

  const [{ data: approvals, error }, { data: weeklyApprovals, error: weeklyError }, reminderEventsRes, autoRunEventsRes] = await Promise.all([
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
      .limit(500),
    supabase
      .from("task_events")
      .select("task_id, created_at, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "SLACK_APPROVAL_POSTED")
      .gte("created_at", sevenDaysAgoIso)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("task_events")
      .select("task_id, created_at, event_type, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["APPROVAL_REMINDER_AUTO_RUN", "APPROVAL_REMINDER_AUTO_SKIPPED"])
      .gte("created_at", sevenDaysAgoIso)
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  if (error) {
    throw new Error(`Failed to load approvals: ${error.message}`);
  }
  if (weeklyError) {
    throw new Error(`Failed to load weekly approvals: ${weeklyError.message}`);
  }
  if (reminderEventsRes.error) {
    throw new Error(`Failed to load reminder events: ${reminderEventsRes.error.message}`);
  }
  if (autoRunEventsRes.error) {
    throw new Error(`Failed to load auto reminder run events: ${autoRunEventsRes.error.message}`);
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
  const reminderRows = (reminderEventsRes.data ?? []) as ReminderEventRow[];
  const reminderEvents = reminderRows
    .map((row) => {
      const payload = parseObject(row.payload_json);
      if (!payload || payload.reminder !== true) return null;
      const source = typeof payload.source === "string" ? payload.source : "unknown";
      const approvalId = typeof payload.approval_id === "string" ? payload.approval_id : null;
      return {
        taskId: row.task_id,
        createdAt: row.created_at,
        source,
        approvalId
      };
    })
    .filter((row): row is { taskId: string; createdAt: string; source: string; approvalId: string | null } => row !== null);
  const reminderTotal = reminderEvents.length;
  const reminderManualCount = reminderEvents.filter((row) => row.source === "manual").length;
  const reminderCronCount = reminderEvents.filter((row) => row.source === "cron").length;
  const reminderUniqueApprovals = new Set(
    reminderEvents.map((row) => row.approvalId).filter((value): value is string => Boolean(value))
  ).size;
  const reminderRecent = reminderEvents.slice(0, 10);
  const autoEvents = (autoRunEventsRes.data ?? []) as Array<{
    task_id: string;
    created_at: string;
    event_type: "APPROVAL_REMINDER_AUTO_RUN" | "APPROVAL_REMINDER_AUTO_SKIPPED";
    payload_json: unknown;
  }>;
  const autoSentRuns = autoEvents.filter((row) => row.event_type === "APPROVAL_REMINDER_AUTO_RUN").length;
  const autoSkippedRuns = autoEvents.filter((row) => row.event_type === "APPROVAL_REMINDER_AUTO_SKIPPED").length;
  const latestAutoEvent = autoEvents[0] ?? null;
  const latestAutoPayload = parseObject(latestAutoEvent?.payload_json ?? null);
  const previousAutoEvent = autoEvents[1] ?? null;
  const previousAutoPayload = parseObject(previousAutoEvent?.payload_json ?? null);
  const latestAutoStaleCount = Number(latestAutoPayload?.stale_pending_count ?? NaN);
  const previousAutoStaleCount = Number(previousAutoPayload?.stale_pending_count ?? NaN);
  const autoStaleDelta =
    Number.isFinite(latestAutoStaleCount) && Number.isFinite(previousAutoStaleCount)
      ? latestAutoStaleCount - previousAutoStaleCount
      : null;
  const currentStalePendingCount = pendingApprovals.filter((approval) => {
    const ageHours = (Date.now() - new Date(approval.created_at).getTime()) / (60 * 60 * 1000);
    return ageHours >= staleHours;
  }).length;
  const suggestedOneOffMinStale =
    currentStalePendingCount >= 10 ? 10 : currentStalePendingCount >= 5 ? 5 : currentStalePendingCount >= 3 ? 3 : 1;
  const taskIds = Array.from(new Set([...filteredApprovals.map((approval) => approval.task_id), ...reminderEvents.map((row) => row.taskId)]));
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
      <form action={resendSelectedApprovalSlackReminders} id="bulk-approval-remind-form" className="rounded-md border border-sky-200 bg-sky-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <ConfirmSubmitButton
            label="選択承認をSlack一括再通知"
            pendingLabel="再通知中..."
            confirmMessage="選択した pending 承認をSlackへ再通知します。実行しますか？"
            className="rounded-md border border-sky-300 bg-white px-2 py-1 text-xs text-sky-700 hover:bg-sky-100"
          />
          <span className="text-xs text-sky-800">各カードのチェック項目で対象を選択</span>
        </div>
      </form>

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

      <section className="rounded-xl border border-sky-200 bg-sky-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-sky-900">リマインド実績（7日）</p>
          <span className="text-xs text-sky-800">SLACK_APPROVAL_POSTED / reminder=true</span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div className="rounded-md border border-sky-200 bg-white p-3">
            <p className="text-xs text-sky-700">送信総数</p>
            <p className="mt-1 text-xl font-semibold text-sky-900">{reminderTotal}</p>
          </div>
          <div className="rounded-md border border-sky-200 bg-white p-3">
            <p className="text-xs text-sky-700">manual</p>
            <p className="mt-1 text-xl font-semibold text-sky-900">{reminderManualCount}</p>
          </div>
          <div className="rounded-md border border-sky-200 bg-white p-3">
            <p className="text-xs text-sky-700">cron</p>
            <p className="mt-1 text-xl font-semibold text-sky-900">{reminderCronCount}</p>
          </div>
          <div className="rounded-md border border-sky-200 bg-white p-3">
            <p className="text-xs text-sky-700">対象承認(ユニーク)</p>
            <p className="mt-1 text-xl font-semibold text-sky-900">{reminderUniqueApprovals}</p>
          </div>
        </div>
        {reminderRecent.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {reminderRecent.map((event, idx) => (
              <li key={`${event.taskId}-${event.createdAt}-${idx}`} className="rounded-md border border-sky-200 bg-white p-2 text-xs text-slate-700">
                <p>
                  <Link href={`/app/tasks/${event.taskId}`} className="font-medium underline">
                    {taskTitleById.get(event.taskId) ?? event.taskId}
                  </Link>
                </p>
                <p className="mt-1 text-slate-500">
                  {new Date(event.createdAt).toLocaleString()} | source: {event.source} | approval_id: {event.approvalId ?? "-"}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-sky-900">直近7日のリマインド送信はありません。</p>
        )}
      </section>

      <section className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-indigo-900">Auto Guard 状態（7日）</p>
          <span className="text-xs text-indigo-800">/api/approvals/reminders/auto</span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div className="rounded-md border border-indigo-200 bg-white p-3">
            <p className="text-xs text-indigo-700">guard threshold</p>
            <p className="mt-1 text-xl font-semibold text-indigo-900">{autoMinStale}</p>
          </div>
          <div className="rounded-md border border-indigo-200 bg-white p-3">
            <p className="text-xs text-indigo-700">current stale pending</p>
            <p className={`mt-1 text-xl font-semibold ${currentStalePendingCount >= autoMinStale ? "text-rose-700" : "text-indigo-900"}`}>
              {currentStalePendingCount}
            </p>
          </div>
          <div className="rounded-md border border-indigo-200 bg-white p-3">
            <p className="text-xs text-indigo-700">auto sent runs</p>
            <p className="mt-1 text-xl font-semibold text-indigo-900">{autoSentRuns}</p>
          </div>
          <div className="rounded-md border border-indigo-200 bg-white p-3">
            <p className="text-xs text-indigo-700">auto skipped runs</p>
            <p className="mt-1 text-xl font-semibold text-indigo-900">{autoSkippedRuns}</p>
          </div>
        </div>
        {latestAutoEvent ? (
          <div className="mt-3 rounded-md border border-indigo-200 bg-white p-3 text-xs text-slate-700">
            <p className="font-medium text-indigo-900">直近 auto 実行結果</p>
            <p className="mt-1 text-slate-600">
              {new Date(latestAutoEvent.created_at).toLocaleString()} | {latestAutoEvent.event_type}
            </p>
            <p className="mt-1 text-slate-600">
              stale={String(latestAutoPayload?.stale_pending_count ?? "-")} threshold={String(latestAutoPayload?.threshold ?? autoMinStale)} reason=
              {String(latestAutoPayload?.reason ?? "-")} sent_count={String(latestAutoPayload?.sent_count ?? 0)}
            </p>
            <p className="mt-1 text-slate-600">
              前回比(stale):{" "}
              {autoStaleDelta === null ? (
                "-"
              ) : autoStaleDelta > 0 ? (
                <span className="font-semibold text-rose-700">+{autoStaleDelta}（悪化）</span>
              ) : autoStaleDelta < 0 ? (
                <span className="font-semibold text-emerald-700">{autoStaleDelta}（改善）</span>
              ) : (
                <span className="font-semibold text-slate-700">0（横ばい）</span>
              )}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-indigo-900">直近7日の auto 実行ログはありません。</p>
        )}
        <p className="mt-3 text-xs text-indigo-900">
          推奨閾値: <span className="font-semibold">{suggestedOneOffMinStale}</span>
          （現在の stale pending 件数 {currentStalePendingCount} に基づく）
        </p>
        <form action={runGuardedAutoReminderNow} className="mt-2">
          <input type="hidden" name="min_stale" value={String(suggestedOneOffMinStale)} />
          <ConfirmSubmitButton
            label={`推奨値(${suggestedOneOffMinStale})で即実行`}
            pendingLabel="実行中..."
            confirmMessage={`推奨閾値 ${suggestedOneOffMinStale} でガード付き再通知を実行します。よろしいですか？`}
            className="rounded-md border border-indigo-300 bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-800 hover:bg-indigo-200"
          />
        </form>
        <form action={runGuardedAutoReminderNow} className="mt-3 rounded-md border border-indigo-200 bg-white p-3">
          <p className="text-xs font-medium text-indigo-900">今回のみ閾値指定で実行</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700">
              min_stale
              <select
                name="min_stale"
                defaultValue={String(suggestedOneOffMinStale)}
                className="rounded-md border border-slate-300 px-2 py-1"
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="5">5</option>
                <option value="10">10</option>
              </select>
            </label>
            <ConfirmSubmitButton
              label="guard付き再通知を実行"
              pendingLabel="実行中..."
              confirmMessage="指定した閾値で今回のみガード判定して再通知を実行します。よろしいですか？"
              className="rounded-md border border-indigo-300 bg-indigo-50 px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100"
            />
          </div>
        </form>
      </section>

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
              <label className="mb-2 inline-flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  name="approval_ids"
                  value={approval.id}
                  form="bulk-approval-remind-form"
                  className="h-4 w-4 rounded border-slate-300"
                />
                一括再通知に含める
              </label>
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
