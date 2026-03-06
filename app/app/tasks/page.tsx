import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { createTask } from "@/app/app/tasks/actions";
import { AGENT_EVENTS_TASK_TITLE } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TasksPageProps = {
  searchParams?: Promise<{
    error?: string;
    ok?: string;
    source?: string;
    case_id?: string;
    ref_from?: string;
    ref_intent?: string;
    ref_ts?: string;
  }>;
};

function barColor(status: string) {
  if (status === "failed") return "bg-rose-500";
  if (status === "ready_for_approval") return "bg-amber-500";
  if (status === "approved") return "bg-sky-500";
  if (status === "executing") return "bg-indigo-500";
  if (status === "done") return "bg-emerald-500";
  return "bg-slate-500";
}

function taskStatusLabel(status: string) {
  if (status === "draft") return "下書き";
  if (status === "ready_for_approval") return "承認依頼待ち";
  if (status === "approved") return "承認済み";
  if (status === "executing") return "実行中";
  if (status === "done") return "完了";
  if (status === "failed") return "失敗";
  return status;
}

type TaskSource = "manual" | "slack" | "proposal" | "system";

function sourceBadgeClass(source: TaskSource) {
  if (source === "slack") return "border-sky-300 bg-sky-50 text-sky-700";
  if (source === "proposal") return "border-violet-300 bg-violet-50 text-violet-700";
  if (source === "system") return "border-slate-300 bg-slate-100 text-slate-700";
  return "border-emerald-300 bg-emerald-50 text-emerald-700";
}

function sourceLabel(source: TaskSource | "all") {
  if (source === "all") return "すべて";
  if (source === "manual") return "手動";
  if (source === "slack") return "Slack";
  if (source === "proposal") return "提案";
  if (source === "system") return "システム";
  return source;
}

function caseStatusLabel(status: string) {
  if (status === "open") return "進行中";
  if (status === "resolved") return "解決";
  if (status === "closed") return "クローズ";
  return status;
}

function agentStatusLabel(status: string) {
  if (status === "active") return "有効";
  if (status === "disabled") return "無効";
  return status;
}

function normalizeTaskSource(payload: unknown): TaskSource {
  if (typeof payload !== "object" || payload === null) return "manual";
  const p = payload as Record<string, unknown>;
  const changedFields =
    typeof p.changed_fields === "object" && p.changed_fields !== null
      ? (p.changed_fields as Record<string, unknown>)
      : null;
  const sourceRaw = typeof changedFields?.source === "string" ? changedFields.source : "";
  if (sourceRaw.includes("slack")) return "slack";
  if (sourceRaw.includes("proposal")) return "proposal";
  if (sourceRaw.includes("system")) return "system";
  return "manual";
}

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const params = searchParams ? await searchParams : {};
  const refFrom = typeof params.ref_from === "string" ? params.ref_from : "";
  const refIntent = typeof params.ref_intent === "string" ? params.ref_intent : "";
  const refTs = typeof params.ref_ts === "string" ? params.ref_ts : "";
  const selectedCaseId = String(params.case_id ?? "").trim();
  const isMissingWorkflowTemplatesTable = (message: string) =>
    message.includes('relation "workflow_templates" does not exist') ||
    message.includes("Could not find the table 'public.workflow_templates'");
  const isMissingCasesTable = (message: string) =>
    message.includes('relation "business_cases" does not exist') ||
    message.includes("Could not find the table 'public.business_cases'");
  const isMissingCaseColumn = (message: string) =>
    message.includes("Could not find the 'case_id' column") || message.includes("column tasks.case_id does not exist");
  const tasksWithCaseRes = await supabase
    .from("tasks")
    .select("id, title, status, created_at, agent_id, case_id")
    .eq("org_id", orgId)
    .neq("title", AGENT_EVENTS_TASK_TITLE)
    .order("created_at", { ascending: false });

  let tasksData:
    | Array<{ id: string; title: string; status: string; created_at: string; agent_id: string | null; case_id: string | null }>
    | Array<{ id: string; title: string; status: string; created_at: string; agent_id: string | null }> = [];
  let tasksError: string | null = null;

  if (!tasksWithCaseRes.error) {
    tasksData = (tasksWithCaseRes.data ?? []) as Array<{
      id: string;
      title: string;
      status: string;
      created_at: string;
      agent_id: string | null;
      case_id: string | null;
    }>;
  } else if (isMissingCaseColumn(tasksWithCaseRes.error.message)) {
    const tasksFallbackRes = await supabase
      .from("tasks")
      .select("id, title, status, created_at, agent_id")
      .eq("org_id", orgId)
      .neq("title", AGENT_EVENTS_TASK_TITLE)
      .order("created_at", { ascending: false });
    if (tasksFallbackRes.error) {
      tasksError = tasksFallbackRes.error.message;
    } else {
      tasksData = (tasksFallbackRes.data ?? []) as Array<{
        id: string;
        title: string;
        status: string;
        created_at: string;
        agent_id: string | null;
      }>;
    }
  } else {
    tasksError = tasksWithCaseRes.error.message;
  }

  const [{ data: agents, error: agentsError }, templatesRes, casesRes] = await Promise.all([
    supabase
      .from("agents")
      .select("id, name, status")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    supabase
      .from("workflow_templates")
      .select("id, name")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    supabase
      .from("business_cases")
      .select("id, title, status")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
  ]);

  if (tasksError) {
    throw new Error(`Failed to load tasks: ${tasksError}`);
  }

  if (agentsError) {
    throw new Error(`Failed to load agents: ${agentsError.message}`);
  }

  const templates =
    templatesRes.error && isMissingWorkflowTemplatesTable(templatesRes.error.message)
      ? []
      : ((templatesRes.data ?? []) as Array<{ id: string; name: string }>);
  if (templatesRes.error && !isMissingWorkflowTemplatesTable(templatesRes.error.message)) {
    throw new Error(`Failed to load workflow templates: ${templatesRes.error.message}`);
  }

  const cases =
    casesRes.error && isMissingCasesTable(casesRes.error.message)
      ? []
      : ((casesRes.data ?? []) as Array<{ id: string; title: string; status: string }>);
  if (casesRes.error && !isMissingCasesTable(casesRes.error.message)) {
    throw new Error(`Failed to load cases: ${casesRes.error.message}`);
  }

  const caseTitleById = new Map(cases.map((row) => [row.id, row.title]));
  const tasksList = tasksData as Array<{
    id: string;
    title: string;
    status: string;
    created_at: string;
    agent_id: string | null;
    case_id?: string | null;
  }>;
  const taskIds = tasksList.map((task) => task.id as string);
  const sourceByTaskId = new Map<string, TaskSource>();
  if (taskIds.length > 0) {
    const { data: sourceEvents, error: sourceEventsError } = await supabase
      .from("task_events")
      .select("task_id, event_type, payload_json, created_at")
      .eq("org_id", orgId)
      .in("task_id", taskIds)
      .in("event_type", ["SLACK_TASK_INTAKE", "TASK_CREATED"])
      .order("created_at", { ascending: true });
    if (sourceEventsError) {
      throw new Error(`Failed to load task source events: ${sourceEventsError.message}`);
    }
    for (const row of sourceEvents ?? []) {
      const taskId = row.task_id as string;
      if (row.event_type === "SLACK_TASK_INTAKE") {
        sourceByTaskId.set(taskId, "slack");
        continue;
      }
      if (!sourceByTaskId.has(taskId)) {
        sourceByTaskId.set(taskId, normalizeTaskSource(row.payload_json));
      }
    }
  }

  const selectedSource =
    params.source === "slack" || params.source === "proposal" || params.source === "manual" || params.source === "system"
      ? params.source
      : "all";
  const sourceFilteredTasks =
    selectedSource === "all"
      ? tasksList
      : tasksList.filter((task) => (sourceByTaskId.get(task.id as string) ?? "manual") === selectedSource);
  const filteredTasks = selectedCaseId
    ? sourceFilteredTasks.filter((task) => (task.case_id ?? null) === selectedCaseId)
    : sourceFilteredTasks;
  const hasActiveTaskFilters = selectedSource !== "all" || Boolean(selectedCaseId);
  const taskFilterSummary = [
    selectedSource !== "all" ? `流入ソース=${sourceLabel(selectedSource)}` : null,
    selectedCaseId ? `案件=${caseTitleById.get(selectedCaseId) ?? "案件"}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const currentTaskFilterParams = new URLSearchParams();
  if (selectedSource !== "all") currentTaskFilterParams.set("source", selectedSource);
  if (selectedCaseId) currentTaskFilterParams.set("case_id", selectedCaseId);
  const currentTaskFilterPath =
    currentTaskFilterParams.size > 0 ? `/app/tasks?${currentTaskFilterParams.toString()}` : "/app/tasks";

  const agentNameById = new Map<string, string>((agents ?? []).map((agent) => [agent.id as string, agent.name as string]));
  const statusCounts = new Map<string, number>();
  const sourceCounts = new Map<TaskSource, number>([
    ["manual", 0],
    ["slack", 0],
    ["proposal", 0],
    ["system", 0]
  ]);
  for (const task of tasksList) {
    const source = sourceByTaskId.get(task.id as string) ?? "manual";
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  for (const task of filteredTasks) {
    const key = String(task.status ?? "unknown");
    statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
  }
  const statusOrder = ["draft", "ready_for_approval", "approved", "executing", "done", "failed"];
  const maxStatusCount = Math.max(1, ...Array.from(statusCounts.values()));
  const highlightedTaskId = (() => {
    if (refTs) {
      const exact = filteredTasks.find((task) => String(task.created_at) === refTs);
      if (exact) return String(exact.id);
    }
    if (refIntent === "execute_action" || refIntent === "quick_top_action") {
      const byStatus = filteredTasks.find((task) => String(task.status) === "approved");
      if (byStatus) return String(byStatus.id);
      return filteredTasks[0] ? String(filteredTasks[0].id) : null;
    }
    if (refIntent === "request_approval") {
      const byStatus = filteredTasks.find((task) => String(task.status) === "ready_for_approval");
      if (byStatus) return String(byStatus.id);
      return filteredTasks[0] ? String(filteredTasks[0].id) : null;
    }
    return null;
  })();

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6 shadow-sm">
        <h1 className="text-xl font-semibold">タスク</h1>
        <p className="mt-2 text-sm text-slate-600">現在の組織向けタスクを作成し、進行を追跡します。</p>

        <StatusNotice ok={params.ok} error={params.error} className="mt-4" />
        {refFrom || refIntent || refTs ? (
          <p className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
            参照コンテキスト: {refFrom || "unknown"}
            {refIntent ? ` / ${refIntent}` : ""}
            {refTs ? ` / ${new Date(refTs).toLocaleString("ja-JP")}` : ""}
          </p>
        ) : null}

        <form action={createTask} className="mt-6 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <select name="agent_id" required className="rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">エージェントを選択</option>
              {(agents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id as string} disabled={agent.status !== "active"}>
                  {agent.name as string} ({agentStatusLabel(agent.status as string)})
                </option>
              ))}
            </select>
            <input
              type="text"
              name="title"
              required
              placeholder="タスクタイトル"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <select name="workflow_template_id" className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="">ワークフローテンプレート（任意）</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          <select name="case_id" className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="">案件（任意）</option>
            {cases.map((caseRow) => (
              <option key={caseRow.id} value={caseRow.id}>
                {caseRow.title} ({caseStatusLabel(caseRow.status)})
              </option>
            ))}
          </select>
          <textarea
            name="input_text"
            rows={4}
            placeholder="タスク入力"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <ConfirmSubmitButton
            label="タスクを作成"
            pendingLabel="作成中..."
            confirmMessage="新しいタスクを作成します。実行しますか？"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          />
        </form>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">ステータス可視化</h2>
          <span className="text-xs text-slate-500">0件は棒なし</span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
            <p className="text-slate-600">総タスク</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{filteredTasks.length}</p>
          </div>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
            <p className="text-amber-700">承認待ち系</p>
            <p className="mt-1 text-2xl font-semibold text-amber-900">
              {(statusCounts.get("ready_for_approval") ?? 0) + (statusCounts.get("approved") ?? 0)}
            </p>
          </div>
          <div className={`rounded-md border p-3 text-sm ${(statusCounts.get("failed") ?? 0) > 0 ? "border-rose-300 bg-rose-100" : "border-emerald-200 bg-emerald-50"}`}>
            <p className={`${(statusCounts.get("failed") ?? 0) > 0 ? "text-rose-700" : "text-emerald-700"}`}>失敗タスク</p>
            <p className={`mt-1 text-2xl font-semibold ${(statusCounts.get("failed") ?? 0) > 0 ? "text-rose-900" : "text-emerald-900"}`}>{statusCounts.get("failed") ?? 0}</p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {statusOrder.map((status) => {
            const count = statusCounts.get(status) ?? 0;
            const heightPct = count > 0 ? Math.max(12, Math.round((count / maxStatusCount) * 100)) : 0;
            return (
              <div key={status} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="flex h-36 items-end justify-center rounded-md bg-white px-2">
                  {count > 0 ? (
                    <div className={`w-10 rounded-t-md ${barColor(status)}`} style={{ height: `${heightPct}%` }} />
                  ) : null}
                </div>
                <p className="mt-2 text-center font-mono text-[11px] text-slate-600">{taskStatusLabel(status)}</p>
                <p className="text-center text-sm font-semibold text-slate-900">{count}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <details open={hasActiveTaskFilters} className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer list-none text-xs font-semibold text-slate-700">
            絞り込み（流入ソース / 案件）
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CopyFilterLinkButton path={currentTaskFilterPath} />
            {hasActiveTaskFilters ? (
              <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">条件付き表示</span>
            ) : null}
          </div>
          {hasActiveTaskFilters ? <p className="mt-2 text-xs text-slate-600">{taskFilterSummary}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-slate-700">流入ソース</span>
            {(["all", "manual", "slack", "proposal", "system"] as const).map((source) => {
              const href = source === "all" ? "/app/tasks" : `/app/tasks?source=${source}`;
              const count = source === "all" ? tasksList.length : sourceCounts.get(source as TaskSource) ?? 0;
              const selected = selectedSource === source;
              return (
                <Link
                  key={source}
                  href={href}
                  className={`rounded-full border px-2 py-1 ${selected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"}`}
                >
                  {sourceLabel(source)} ({count})
                </Link>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-slate-700">案件</span>
            <Link
              href={selectedSource === "all" ? "/app/tasks" : `/app/tasks?source=${selectedSource}`}
              className={`rounded-full border px-2 py-1 ${selectedCaseId ? "border-slate-300 bg-white text-slate-700" : "border-slate-900 bg-slate-900 text-white"}`}
            >
              すべて
            </Link>
            {cases.slice(0, 12).map((caseRow) => {
              const href =
                selectedSource === "all"
                  ? `/app/tasks?case_id=${caseRow.id}`
                  : `/app/tasks?source=${selectedSource}&case_id=${caseRow.id}`;
              const selected = selectedCaseId === caseRow.id;
              return (
                <Link
                  key={caseRow.id}
                  href={href}
                  className={`rounded-full border px-2 py-1 ${selected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"}`}
                >
                  {caseRow.title}
                </Link>
              );
            })}
            <Link href="/app/cases" className="rounded-full border border-slate-300 bg-white px-2 py-1 text-slate-700">
              + 案件管理
            </Link>
          </div>
        </details>
        <h2 className="text-lg font-semibold">タスク一覧</h2>
        {filteredTasks.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {filteredTasks.map((task) => {
              const isRef = highlightedTaskId !== null && String(task.id) === highlightedTaskId;
              return (
              <li
                key={task.id}
                id={isRef ? "ref-target" : undefined}
                className={`rounded-md border p-4 ${
                  isRef
                    ? "border-indigo-300 bg-indigo-50/50 ring-1 ring-indigo-200"
                    : task.status === "failed"
                      ? "border-rose-300 bg-rose-50"
                      : "border-slate-200"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Link href={`/app/tasks/${task.id}`} className="font-medium text-slate-900 hover:underline">
                    {task.title as string}
                  </Link>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${sourceBadgeClass(sourceByTaskId.get(task.id as string) ?? "manual")}`}
                  >
                    {sourceLabel(sourceByTaskId.get(task.id as string) ?? "manual")}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  ステータス: {taskStatusLabel(task.status as string)} | エージェント:{" "}
                  {task.agent_id ? agentNameById.get(task.agent_id as string) ?? "未割り当て" : "未割り当て"}
                </p>
                {task.case_id ? (
                  <p className="mt-1 text-xs text-slate-500">
                    案件: {caseTitleById.get(task.case_id) ?? "案件"}
                  </p>
                ) : null}
              </li>
            );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-slate-600">タスクはまだありません。上から作成してください。</p>
        )}
      </section>
    </div>
  );
}
