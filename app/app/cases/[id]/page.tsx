import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { updateCaseStatus } from "@/app/app/cases/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type CaseDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

type CaseRow = {
  id: string;
  title: string;
  case_type: string;
  status: "open" | "blocked" | "closed";
  source: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

type CaseEventRow = {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  payload_json: unknown;
  created_at: string;
};

type TaskRow = {
  id: string;
  title: string;
  status: string;
  created_at: string;
  agent_id: string | null;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function pretty(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function statusBadge(status: CaseRow["status"]) {
  if (status === "blocked") return "border-rose-300 bg-rose-50 text-rose-700";
  if (status === "closed") return "border-slate-300 bg-slate-100 text-slate-700";
  return "border-emerald-300 bg-emerald-50 text-emerald-700";
}

export default async function CaseDetailPage({ params, searchParams }: CaseDetailPageProps) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const [caseRes, tasksRes, caseEventsRes, approvalsRes, actionsRes, agentsRes] = await Promise.all([
    supabase
      .from("business_cases")
      .select("id, title, case_type, status, source, created_by_user_id, created_at, updated_at")
      .eq("org_id", orgId)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("tasks")
      .select("id, title, status, created_at, agent_id")
      .eq("org_id", orgId)
      .eq("case_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("case_events")
      .select("id, event_type, actor_user_id, payload_json, created_at")
      .eq("org_id", orgId)
      .eq("case_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("approvals")
      .select("id, task_id, status, reason, approver_user_id, created_at, decided_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(400),
    supabase
      .from("actions")
      .select("id, task_id, provider, action_type, status, created_at, result_json")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(400),
    supabase
      .from("agents")
      .select("id, name, role_key")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200)
  ]);

  if (caseRes.error) {
    if (isMissingTableError(caseRes.error.message, "business_cases")) {
      return (
        <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h1 className="text-xl font-semibold text-amber-900">案件詳細</h1>
          <p className="text-sm text-amber-800">
            `business_cases` テーブルが未適用です。`supabase db push` を実行してください。
          </p>
        </section>
      );
    }
    throw new Error(`Failed to load case: ${caseRes.error.message}`);
  }

  const caseRow = caseRes.data as CaseRow | null;
  if (!caseRow) notFound();

  if (tasksRes.error) {
    throw new Error(`Failed to load case tasks: ${tasksRes.error.message}`);
  }
  if (approvalsRes.error) {
    throw new Error(`Failed to load approvals: ${approvalsRes.error.message}`);
  }
  if (actionsRes.error) {
    throw new Error(`Failed to load actions: ${actionsRes.error.message}`);
  }
  if (agentsRes.error) {
    throw new Error(`Failed to load agents: ${agentsRes.error.message}`);
  }

  const taskRows = (tasksRes.data ?? []) as TaskRow[];
  const taskIds = new Set(taskRows.map((row) => row.id));
  const taskById = new Map(taskRows.map((row) => [row.id, row]));

  const caseEvents =
    caseEventsRes.error && isMissingTableError(caseEventsRes.error.message, "case_events")
      ? []
      : ((caseEventsRes.data ?? []) as CaseEventRow[]);
  if (caseEventsRes.error && !isMissingTableError(caseEventsRes.error.message, "case_events")) {
    throw new Error(`Failed to load case events: ${caseEventsRes.error.message}`);
  }

  const agentMap = new Map(
    ((agentsRes.data ?? []) as Array<{ id: string; name: string; role_key: string }>).map((agent) => [agent.id, agent])
  );

  const approvals = ((approvalsRes.data ?? []) as Array<{
    id: string;
    task_id: string;
    status: string;
    reason: string | null;
    approver_user_id: string | null;
    created_at: string;
    decided_at: string | null;
  }>).filter((row) => taskIds.has(row.task_id));

  const actions = ((actionsRes.data ?? []) as Array<{
    id: string;
    task_id: string;
    provider: string;
    action_type: string;
    status: string;
    created_at: string;
    result_json: unknown;
  }>).filter((row) => taskIds.has(row.task_id));

  const pendingApprovals = approvals.filter((row) => row.status === "pending").length;
  const failedActions = actions.filter((row) => row.status === "failed").length;
  const successActions = actions.filter((row) => row.status === "success").length;
  const pendingApprovalRows = approvals.filter((row) => row.status === "pending").slice(0, 8);
  const failedActionRows = actions.filter((row) => row.status === "failed").slice(0, 8);

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Case Ledger</p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">{caseRow.title}</h1>
            <p className="mt-1 text-sm text-slate-600">{caseRow.case_type}</p>
          </div>
          <div className={`rounded-full border px-3 py-1 text-xs ${statusBadge(caseRow.status)}`}>{caseRow.status}</div>
        </div>
        <StatusNotice ok={sp.ok} error={sp.error} className="mt-4" />
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/app/cases" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50">
            案件一覧へ戻る
          </Link>
          <Link
            href={`/app/tasks?case_id=${caseRow.id}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
          >
            この案件のタスク一覧
          </Link>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-700">PENDING APPROVALS</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{pendingApprovals}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs text-emerald-700">ACTION SUCCESS</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{successActions}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-xs text-rose-700">ACTION FAILED</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{failedActions}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">案件操作</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {(["open", "blocked", "closed"] as const).map((status) => (
            <form key={status} action={updateCaseStatus}>
              <input type="hidden" name="case_id" value={caseRow.id} />
              <input type="hidden" name="status" value={status} />
              <ConfirmSubmitButton
                label={status}
                pendingLabel="更新中..."
                confirmMessage={`案件ステータスを ${status} に変更します。よろしいですか？`}
                className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100"
              />
            </form>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">優先トリアージ</h2>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/app/approvals?stale_only=1"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-100"
            >
              承認キューへ
            </Link>
            <Link
              href="/app/operations/exceptions"
              className="rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs text-rose-800 hover:bg-rose-100"
            >
              例外キューへ
            </Link>
          </div>
        </div>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-medium text-amber-800">承認待ちタスク</p>
            {pendingApprovalRows.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {pendingApprovalRows.map((row) => (
                  <li key={row.id} className="rounded-md border border-amber-200 bg-white p-2 text-xs text-slate-700">
                    <Link href={`/app/tasks/${row.task_id}`} className="font-medium text-slate-900 underline">
                      {taskById.get(row.task_id)?.title ?? row.task_id}
                    </Link>
                    <p className="mt-1 text-[11px] text-slate-500">requested: {new Date(row.created_at).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-600">承認待ちはありません。</p>
            )}
          </div>
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs font-medium text-rose-800">失敗アクション</p>
            {failedActionRows.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {failedActionRows.map((row) => (
                  <li key={row.id} className="rounded-md border border-rose-200 bg-white p-2 text-xs text-slate-700">
                    <Link href={`/app/tasks/${row.task_id}`} className="font-medium text-slate-900 underline">
                      {taskById.get(row.task_id)?.title ?? row.task_id}
                    </Link>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {row.provider}/{row.action_type} | {new Date(row.created_at).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-600">失敗アクションはありません。</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">紐づくタスク</h2>
        {taskRows.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {taskRows.map((task) => {
              const agent = task.agent_id ? agentMap.get(task.agent_id) : null;
              return (
                <li key={task.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <Link href={`/app/tasks/${task.id}`} className="font-medium text-slate-900 hover:underline">
                      {task.title}
                    </Link>
                    <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">
                      {task.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    created: {new Date(task.created_at).toLocaleString()} | agent: {agent ? `${agent.name} (${agent.role_key})` : "未割当"}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">この案件に紐づくタスクはありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Case Events</h2>
        {caseEvents.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {caseEvents.map((event) => (
              <li key={event.id} className="rounded-md border border-slate-200 p-3">
                <p className="text-sm font-medium text-slate-900">{event.event_type}</p>
                <p className="mt-1 text-xs text-slate-500">
                  actor: {event.actor_user_id ?? "system"} | {new Date(event.created_at).toLocaleString()}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-700">payload JSON</summary>
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-[11px] text-slate-700">{pretty(event.payload_json)}</pre>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">case_events はまだありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">承認と実行（案件内）</h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="text-sm font-medium text-slate-800">Approvals</p>
            {approvals.length > 0 ? (
              <ul className="mt-2 space-y-2 text-sm text-slate-700">
                {approvals.slice(0, 30).map((approval) => (
                  <li key={approval.id} className="rounded-md border border-slate-200 p-3">
                    <p>
                      task:{" "}
                      <Link href={`/app/tasks/${approval.task_id}`} className="underline">
                        {taskById.get(approval.task_id)?.title ?? approval.task_id}
                      </Link>
                    </p>
                    <p>status: {approval.status}</p>
                    <p>reason: {approval.reason ?? "（なし）"}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-600">承認履歴はありません。</p>
            )}
          </div>
          <div>
            <p className="text-sm font-medium text-slate-800">Actions</p>
            {actions.length > 0 ? (
              <ul className="mt-2 space-y-2 text-sm text-slate-700">
                {actions.slice(0, 30).map((action) => (
                  <li key={action.id} className="rounded-md border border-slate-200 p-3">
                    <p>
                      task:{" "}
                      <Link href={`/app/tasks/${action.task_id}`} className="underline">
                        {taskById.get(action.task_id)?.title ?? action.task_id}
                      </Link>
                    </p>
                    <p>
                      {action.provider}/{action.action_type} | {action.status}
                    </p>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-slate-700">result JSON</summary>
                      <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-[11px] text-slate-700">{pretty(action.result_json)}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-600">実行履歴はありません。</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
