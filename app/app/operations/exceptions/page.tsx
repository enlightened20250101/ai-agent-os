import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import {
  bulkUpdateExceptionCases,
  notifyExceptionCasesNow,
  prepareExceptionRecoveryQuestion,
  retryTopFailedWorkflowRuns,
  retryWorkflowRunFromExceptions,
  upsertExceptionCase
} from "@/app/app/operations/exceptions/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type ExceptionsPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
    owner?: string;
    case_status?: string;
    overdue_only?: string;
    sort?: string;
    view?: string;
    export_limit?: string;
    export_offset?: string;
    include_payload?: string;
  }>;
};

type TaskLite = {
  id: string;
  title: string;
  status: string;
  created_at: string;
};

type ExceptionKind = "failed_action" | "failed_workflow" | "stale_approval" | "policy_block";

type ExceptionCase = {
  id: string;
  kind: ExceptionKind;
  ref_id: string;
  task_id: string | null;
  status: "open" | "in_progress" | "resolved";
  owner_user_id: string | null;
  note: string;
  due_at: string | null;
  last_alerted_at: string | null;
  updated_at: string;
};

type ExceptionCaseEvent = {
  id: string;
  exception_case_id: string;
  actor_user_id: string | null;
  event_type: string;
  payload_json: unknown;
  created_at: string;
};

function isMissingTable(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function hoursAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  return Math.floor(diffMs / (60 * 60 * 1000));
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function priorityTone(score: number) {
  if (score >= 80) return "critical";
  if (score >= 55) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function priorityClass(tone: string) {
  if (tone === "critical") return "bg-rose-100 text-rose-800 border-rose-200";
  if (tone === "high") return "bg-amber-100 text-amber-800 border-amber-200";
  if (tone === "medium") return "bg-sky-100 text-sky-800 border-sky-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function formatDaysFromHours(hours: number) {
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return `${days}d ${rem}h`;
}

function overdueHoursFromDueAt(dueAt: string | null) {
  if (!dueAt) return 0;
  const dueMs = new Date(dueAt).getTime();
  if (!Number.isFinite(dueMs) || dueMs >= Date.now()) return 0;
  return Math.floor((Date.now() - dueMs) / (60 * 60 * 1000));
}

function toDateTimeLocalValue(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

export default async function ExceptionsPage({ searchParams }: ExceptionsPageProps) {
  const sp = searchParams ? await searchParams : {};
  const requestedOwner = String(sp.owner ?? "all");
  const requestedCaseStatus = String(sp.case_status ?? "all");
  const requestedOverdueOnly = String(sp.overdue_only ?? "") === "1";
  const selectedSort = String(sp.sort ?? "priority_desc");
  const selectedView = String(sp.view ?? "all");
  const exportLimitRaw = Number.parseInt(String(sp.export_limit ?? "5000"), 10);
  const exportOffsetRaw = Number.parseInt(String(sp.export_offset ?? "0"), 10);
  const selectedExportLimit = Number.isNaN(exportLimitRaw) ? 5000 : Math.max(1, Math.min(10000, exportLimitRaw));
  const selectedExportOffset = Number.isNaN(exportOffsetRaw) ? 0 : Math.max(0, exportOffsetRaw);
  const includePayload = String(sp.include_payload ?? "1") !== "0";
  const { orgId, userId } = await requireOrgContext();
  const selectedOwner =
    selectedView === "my_open"
      ? userId
      : selectedView === "overdue_unassigned"
        ? "unassigned"
        : requestedOwner;
  const selectedCaseStatus =
    selectedView === "my_open" ? "open" : selectedView === "overdue_unassigned" ? "all" : requestedCaseStatus;
  const overdueOnly = selectedView === "overdue_unassigned" ? true : requestedOverdueOnly;
  const supabase = await createClient();

  const pendingThresholdHoursRaw = Number.parseInt(process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6", 10);
  const pendingThresholdHours = Number.isNaN(pendingThresholdHoursRaw)
    ? 6
    : Math.max(1, Math.min(168, pendingThresholdHoursRaw));

  const [failedActionsRes, failedRunsRes, pendingApprovalsRes, policyCheckedRes, casesRes, membersRes, eventsRes, monitorRecoveryLogsRes] =
    await Promise.all([
    supabase
      .from("actions")
      .select("id, task_id, provider, action_type, created_at, result_json")
      .eq("org_id", orgId)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("workflow_runs")
      .select("id, task_id, current_step_key, started_at, finished_at")
      .eq("org_id", orgId)
      .eq("status", "failed")
      .order("finished_at", { ascending: false })
      .limit(30),
    supabase
      .from("approvals")
      .select("id, task_id, created_at, requested_by")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50),
    supabase
      .from("task_events")
      .select("id, task_id, created_at, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "POLICY_CHECKED")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("exception_cases")
      .select("id, kind, ref_id, task_id, status, owner_user_id, note, due_at, last_alerted_at, updated_at")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(500),
    supabase
      .from("memberships")
      .select("user_id, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: true })
      .limit(200),
    supabase
      .from("exception_case_events")
      .select("id, exception_case_id, actor_user_id, event_type, payload_json, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("ai_execution_logs")
      .select("id, metadata_json, created_at")
      .eq("org_id", orgId)
      .eq("source", "chat")
      .eq("intent_type", "monitor_recovery_run")
      .eq("execution_status", "done")
      .order("created_at", { ascending: false })
      .limit(30)
  ]);

  if (failedActionsRes.error) {
    throw new Error(`Failed to load failed actions: ${failedActionsRes.error.message}`);
  }
  if (failedRunsRes.error && !isMissingTable(failedRunsRes.error.message, "workflow_runs")) {
    throw new Error(`Failed to load failed workflow runs: ${failedRunsRes.error.message}`);
  }
  if (pendingApprovalsRes.error) {
    throw new Error(`Failed to load pending approvals: ${pendingApprovalsRes.error.message}`);
  }
  if (policyCheckedRes.error) {
    throw new Error(`Failed to load policy events: ${policyCheckedRes.error.message}`);
  }
  if (casesRes.error && !isMissingTable(casesRes.error.message, "exception_cases")) {
    throw new Error(`Failed to load exception cases: ${casesRes.error.message}`);
  }
  if (membersRes.error) {
    throw new Error(`Failed to load memberships: ${membersRes.error.message}`);
  }
  if (eventsRes.error && !isMissingTable(eventsRes.error.message, "exception_case_events")) {
    throw new Error(`Failed to load exception case events: ${eventsRes.error.message}`);
  }
  if (monitorRecoveryLogsRes.error && !isMissingTable(monitorRecoveryLogsRes.error.message, "ai_execution_logs")) {
    throw new Error(`Failed to load monitor recovery logs: ${monitorRecoveryLogsRes.error.message}`);
  }

  const failedActions = (failedActionsRes.data ?? []) as Array<{
    id: string;
    task_id: string;
    provider: string;
    action_type: string;
    created_at: string;
    result_json: unknown;
  }>;
  const failedRuns = ((failedRunsRes.data ?? []) as Array<{
    id: string;
    task_id: string;
    current_step_key: string | null;
    started_at: string;
    finished_at: string | null;
  }>) ?? [];
  const pendingApprovals = (pendingApprovalsRes.data ?? []) as Array<{
    id: string;
    task_id: string;
    created_at: string;
    requested_by: string | null;
  }>;
  const exceptionCases = (casesRes.data ?? []) as ExceptionCase[];
  const exceptionCaseEvents = (eventsRes.data ?? []) as ExceptionCaseEvent[];
  const monitorRecoveryLogs = (monitorRecoveryLogsRes.data ?? []) as Array<{
    id: string;
    metadata_json: unknown;
    created_at: string;
  }>;
  const members = (membersRes.data ?? []) as Array<{ user_id: string; created_at: string }>;
  const ownerUsers = members.map((row) => row.user_id);
  const profilesRes =
    ownerUsers.length > 0
      ? await supabase.from("user_profiles").select("user_id, display_name").eq("org_id", orgId).in("user_id", ownerUsers)
      : { data: [], error: null };
  if (profilesRes.error && !isMissingTable(profilesRes.error.message, "user_profiles")) {
    throw new Error(`Failed to load user profiles: ${profilesRes.error.message}`);
  }
  const displayNameByUserId = new Map(
    ((profilesRes.data ?? []) as Array<{ user_id: string; display_name: string | null }>)
      .map((row) => [row.user_id, (row.display_name ?? "").trim()] as const)
      .filter((row): row is [string, string] => Boolean(row[0]) && Boolean(row[1]))
  );
  const memberLabel = (userId: string | null | undefined, fallback = "未割当") => {
    if (!userId) return fallback;
    return displayNameByUserId.get(userId) ?? "表示名未設定メンバー";
  };

  const monitorManualWorkflowFailures: Array<{
    workflowRunId: string;
    reasonSummary: string;
    createdAt: string;
  }> = [];
  const seenManualFailureRunIds = new Set<string>();
  for (const row of monitorRecoveryLogs) {
    const meta = asObject(row.metadata_json);
    const result = asObject(meta?.result);
    const workflowRetry = asObject(result?.workflow_retry);
    const failedDetails = Array.isArray(workflowRetry?.failed_details) ? workflowRetry.failed_details : [];
    for (const detailRow of failedDetails) {
      const detail = asObject(detailRow);
      if (!detail) continue;
      if (detail.reason_class !== "manual") continue;
      const workflowRunId = typeof detail.workflow_run_id === "string" ? detail.workflow_run_id : null;
      if (!workflowRunId || seenManualFailureRunIds.has(workflowRunId)) continue;
      seenManualFailureRunIds.add(workflowRunId);
      monitorManualWorkflowFailures.push({
        workflowRunId,
        reasonSummary:
          typeof detail.reason_summary === "string" && detail.reason_summary.length > 0
            ? detail.reason_summary
            : "詳細理由なし",
        createdAt: row.created_at
      });
    }
  }

  const stalePendingApprovals = pendingApprovals.filter((row) => hoursAgo(row.created_at) >= pendingThresholdHours);

  const blockTaskIds = new Set<string>();
  for (const row of policyCheckedRes.data ?? []) {
    const payload = asObject(row.payload_json);
    if (payload?.status === "block" && typeof row.task_id === "string") {
      blockTaskIds.add(row.task_id);
    }
  }

  const taskIds = new Set<string>();
  for (const row of failedActions) taskIds.add(row.task_id);
  for (const row of failedRuns) taskIds.add(row.task_id);
  for (const row of stalePendingApprovals) taskIds.add(row.task_id);
  for (const taskId of blockTaskIds) taskIds.add(taskId);

  const taskIdList = Array.from(taskIds);
  const taskMap = new Map<string, TaskLite>();
  if (taskIdList.length > 0) {
    const { data: tasks, error: tasksError } = await supabase
      .from("tasks")
      .select("id, title, status, created_at")
      .eq("org_id", orgId)
      .in("id", taskIdList);

    if (tasksError) {
      throw new Error(`Failed to load exception tasks: ${tasksError.message}`);
    }

    for (const row of tasks ?? []) {
      taskMap.set(row.id as string, {
        id: row.id as string,
        title: row.title as string,
        status: row.status as string,
        created_at: row.created_at as string
      });
    }
  }

  const blockedTasks = Array.from(blockTaskIds)
    .map((id) => taskMap.get(id))
    .filter((row): row is TaskLite => Boolean(row))
    .slice(0, 30);

  const failedActionsWithPriority = failedActions
    .map((row) => {
      const task = taskMap.get(row.task_id);
      const age = Math.max(0, hoursAgo(row.created_at));
      const taskRisk =
        task?.status === "approved" || task?.status === "executing"
          ? 30
          : task?.status === "ready_for_approval"
            ? 20
            : 10;
      const score = Math.min(100, 30 + Math.min(40, age * 2) + taskRisk);
      return { row, task, score, tone: priorityTone(score) };
    })
    .sort((a, b) => b.score - a.score);

  const workflowRunTaskTitleByRunId = new Map<string, string>();
  for (const run of failedRuns) {
    const task = taskMap.get(run.task_id);
    if (task?.title) {
      workflowRunTaskTitleByRunId.set(run.id, task.title);
    }
  }

  const failedRunsWithPriority = failedRuns
    .map((row) => {
      const task = taskMap.get(row.task_id);
      const finishedAge = row.finished_at ? Math.max(0, hoursAgo(row.finished_at)) : 1;
      const taskRisk = task?.status === "approved" || task?.status === "executing" ? 35 : 20;
      const score = Math.min(100, 35 + Math.min(35, finishedAge * 2) + taskRisk);
      return { row, task, score, tone: priorityTone(score) };
    })
    .sort((a, b) => b.score - a.score);

  const staleApprovalsWithPriority = stalePendingApprovals
    .map((row) => {
      const task = taskMap.get(row.task_id);
      const pendingHours = Math.max(0, hoursAgo(row.created_at));
      const taskRisk = task?.status === "ready_for_approval" ? 20 : 10;
      const score = Math.min(100, 25 + Math.min(50, pendingHours * 2) + taskRisk);
      return { row, task, score, tone: priorityTone(score), pendingHours };
    })
    .sort((a, b) => b.score - a.score);

  const blockedTasksWithPriority = blockedTasks
    .map((task) => {
      const age = Math.max(0, hoursAgo(task.created_at));
      const taskRisk = task.status === "ready_for_approval" ? 30 : task.status === "approved" ? 25 : 15;
      const score = Math.min(100, 40 + Math.min(30, age) + taskRisk);
      return { task, score, tone: priorityTone(score) };
    })
    .sort((a, b) => b.score - a.score);

  const caseMap = new Map<string, ExceptionCase>();
  for (const row of exceptionCases) {
    caseMap.set(`${row.kind}:${row.ref_id}`, row);
  }

  const unresolvedCases = exceptionCases.filter((row) => row.status !== "resolved");
  const unresolvedOverdueCases = unresolvedCases.filter((row) => {
    if (!row.due_at) return false;
    const dueMs = new Date(row.due_at).getTime();
    return Number.isFinite(dueMs) && dueMs < Date.now();
  });
  const ownerBacklog = new Map<
    string,
    { owner: string; open: number; inProgress: number; overdue: number; total: number }
  >();
  for (const row of unresolvedCases) {
    const owner = row.owner_user_id ?? "unassigned";
    const current = ownerBacklog.get(owner) ?? {
      owner,
      open: 0,
      inProgress: 0,
      overdue: 0,
      total: 0
    };
    if (row.status === "open") current.open += 1;
    if (row.status === "in_progress") current.inProgress += 1;
    if (row.due_at) {
      const dueMs = new Date(row.due_at).getTime();
      if (Number.isFinite(dueMs) && dueMs < Date.now()) current.overdue += 1;
    }
    current.total += 1;
    ownerBacklog.set(owner, current);
  }
  const ownerBacklogRows = Array.from(ownerBacklog.values()).sort((a, b) => {
    if (b.overdue !== a.overdue) return b.overdue - a.overdue;
    return b.total - a.total;
  });

  function getCase(kind: ExceptionKind, refId: string) {
    return caseMap.get(`${kind}:${refId}`) ?? null;
  }

  function matchFilters(exceptionCase: ExceptionCase | null) {
    if (!exceptionCase) {
      if (selectedCaseStatus !== "all") return false;
      if (selectedOwner !== "all") return false;
      if (overdueOnly) return false;
      return true;
    }
    if (selectedCaseStatus !== "all" && exceptionCase.status !== selectedCaseStatus) return false;
    if (selectedOwner === "unassigned" && exceptionCase.owner_user_id) return false;
    if (selectedOwner !== "all" && selectedOwner !== "unassigned" && exceptionCase.owner_user_id !== selectedOwner) {
      return false;
    }
    if (overdueOnly) {
      if (!exceptionCase.due_at || exceptionCase.status === "resolved") return false;
      const dueMs = new Date(exceptionCase.due_at).getTime();
      if (!Number.isFinite(dueMs) || dueMs >= Date.now()) return false;
    }
    return true;
  }

  const filteredFailedActionsWithPriority = failedActionsWithPriority.filter(({ row }) =>
    matchFilters(getCase("failed_action", row.id))
  );
  const filteredFailedRunsWithPriority = failedRunsWithPriority.filter(({ row }) =>
    matchFilters(getCase("failed_workflow", row.id))
  );
  const filteredStaleApprovalsWithPriority = staleApprovalsWithPriority.filter(({ row }) =>
    matchFilters(getCase("stale_approval", row.id))
  );
  const filteredBlockedTasksWithPriority = blockedTasksWithPriority.filter(({ task }) =>
    matchFilters(getCase("policy_block", task.id))
  );

  const filteredUnresolvedCases = unresolvedCases.filter((row) => matchFilters(row));
  const filteredOverdueCases = unresolvedOverdueCases.filter((row) => matchFilters(row));
  const filteredMaxOverdueHours =
    filteredOverdueCases.length > 0
      ? Math.max(
          ...filteredOverdueCases.map((row) => {
            const dueMs = row.due_at ? new Date(row.due_at).getTime() : Date.now();
            return Math.max(0, Math.floor((Date.now() - dueMs) / (60 * 60 * 1000)));
          })
        )
      : 0;
  const filteredOwnerBacklogRows = ownerBacklogRows.filter((row) => {
    if (selectedOwner === "all") return true;
    if (selectedOwner === "unassigned") return row.owner === "unassigned";
    return row.owner === selectedOwner;
  });
  const caseStatusLabel = (status: string) => {
    if (status === "open") return "未着手";
    if (status === "in_progress") return "対応中";
    if (status === "resolved") return "解決";
    return status;
  };
  const caseKindLabel = (kind: string) => {
    if (kind === "failed_action") return "失敗アクション";
    if (kind === "failed_workflow") return "失敗ワークフロー";
    if (kind === "stale_approval") return "承認滞留";
    if (kind === "policy_block") return "ポリシーブロック";
    return kind;
  };

  function dueTs(caseRow: ExceptionCase | null) {
    if (!caseRow?.due_at) return Number.POSITIVE_INFINITY;
    const ts = new Date(caseRow.due_at).getTime();
    return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
  }

  function updatedTs(caseRow: ExceptionCase | null) {
    if (!caseRow?.updated_at) return 0;
    const ts = new Date(caseRow.updated_at).getTime();
    return Number.isFinite(ts) ? ts : 0;
  }

  const sortedFailedActionsWithPriority = [...filteredFailedActionsWithPriority].sort((a, b) => {
    if (selectedSort === "due_asc") {
      const d = dueTs(getCase("failed_action", a.row.id)) - dueTs(getCase("failed_action", b.row.id));
      if (d !== 0) return d;
    } else if (selectedSort === "updated_desc") {
      const d =
        updatedTs(getCase("failed_action", b.row.id)) - updatedTs(getCase("failed_action", a.row.id));
      if (d !== 0) return d;
    }
    return b.score - a.score;
  });
  const sortedFailedRunsWithPriority = [...filteredFailedRunsWithPriority].sort((a, b) => {
    if (selectedSort === "due_asc") {
      const d = dueTs(getCase("failed_workflow", a.row.id)) - dueTs(getCase("failed_workflow", b.row.id));
      if (d !== 0) return d;
    } else if (selectedSort === "updated_desc") {
      const d =
        updatedTs(getCase("failed_workflow", b.row.id)) -
        updatedTs(getCase("failed_workflow", a.row.id));
      if (d !== 0) return d;
    }
    return b.score - a.score;
  });
  const sortedStaleApprovalsWithPriority = [...filteredStaleApprovalsWithPriority].sort((a, b) => {
    if (selectedSort === "due_asc") {
      const d = dueTs(getCase("stale_approval", a.row.id)) - dueTs(getCase("stale_approval", b.row.id));
      if (d !== 0) return d;
    } else if (selectedSort === "updated_desc") {
      const d =
        updatedTs(getCase("stale_approval", b.row.id)) - updatedTs(getCase("stale_approval", a.row.id));
      if (d !== 0) return d;
    }
    return b.score - a.score;
  });
  const sortedBlockedTasksWithPriority = [...filteredBlockedTasksWithPriority].sort((a, b) => {
    if (selectedSort === "due_asc") {
      const d = dueTs(getCase("policy_block", a.task.id)) - dueTs(getCase("policy_block", b.task.id));
      if (d !== 0) return d;
    } else if (selectedSort === "updated_desc") {
      const d =
        updatedTs(getCase("policy_block", b.task.id)) - updatedTs(getCase("policy_block", a.task.id));
      if (d !== 0) return d;
    }
    return b.score - a.score;
  });

  const totalExceptions =
    filteredFailedActionsWithPriority.length +
    filteredFailedRunsWithPriority.length +
    filteredStaleApprovalsWithPriority.length +
    filteredBlockedTasksWithPriority.length;
  const exportParams = new URLSearchParams();
  exportParams.set("owner", selectedOwner);
  exportParams.set("case_status", selectedCaseStatus);
  if (overdueOnly) {
    exportParams.set("overdue_only", "1");
  }
  exportParams.set("sort", selectedSort);
  exportParams.set("view", selectedView);
  exportParams.set("limit", String(selectedExportLimit));
  exportParams.set("offset", String(selectedExportOffset));
  exportParams.set("include_payload", includePayload ? "1" : "0");
  const exportCsvHref = `/api/operations/exceptions/export?${exportParams.toString()}`;
  const exportJsonHref = `/api/operations/exceptions/export?${exportParams.toString()}&format=json`;

  function guidanceForKind(args: {
    kind: ExceptionKind;
    owner: string | null;
    dueAt: string | null;
    taskLabel: string;
  }) {
    const { kind, owner, dueAt, taskLabel } = args;
    const overdueHours = overdueHoursFromDueAt(dueAt);
    const ownerText = owner ?? "未割当";
    const urgencyText = overdueHours > 0 ? `${overdueHours}h超過` : "期限内";

    if (kind === "failed_action") {
      return {
        nextAction: `${taskLabel} の実行ログ原因を確認し、再試行可否を判断してから再実行します（担当: ${ownerText} / ${urgencyText}）。`,
        question: "直近の設定変更や外部API制限に変更はありましたか？"
      };
    }
    if (kind === "failed_workflow") {
      return {
        nextAction: `${taskLabel} の失敗ステップ入出力を確認し、再試行または差戻しを選びます（担当: ${ownerText} / ${urgencyText}）。`,
        question: "どのステップ結果が不整合で、再実行の前提条件は満たされていますか？"
      };
    }
    if (kind === "stale_approval") {
      return {
        nextAction: `${taskLabel} の承認者へ期限付きリマインドを送り、必要なら代替承認者へエスカレーションします（担当: ${ownerText} / ${urgencyText}）。`,
        question: "この承認を止めている判断材料は何で、追加情報は何が必要ですか？"
      };
    }
    return {
      nextAction: `${taskLabel} のポリシーブロック理由を確認し、入力値修正または例外承認ルートへ回します（担当: ${ownerText} / ${urgencyText}）。`,
      question: "どのポリシー条件に抵触しており、修正可能な入力項目はどれですか？"
    };
  }

function renderGuidance(args: {
    kind: ExceptionKind;
    owner: string | null;
    dueAt: string | null;
    taskLabel: string;
  }) {
    const guide = guidanceForKind(args);
    const overdueHours = overdueHoursFromDueAt(args.dueAt);
    const level =
      overdueHours >= 24 ? "critical" : overdueHours >= 8 ? "high" : overdueHours >= 2 ? "medium" : "low";
    return (
      <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 p-2 text-xs text-indigo-900">
        <p>
          <span className="font-semibold">SLAレベル:</span>{" "}
          <span className="uppercase">{level}</span>
        </p>
        <p>
          <span className="font-semibold">次アクション:</span> {guide.nextAction}
        </p>
        <p className="mt-1">
          <span className="font-semibold">回収質問テンプレ:</span> {guide.question}
        </p>
      </div>
    );
  }

  function classifyManualWorkflowFailureReason(reasonSummary: string) {
    const s = reasonSummary.toLowerCase();
    if (s.includes("auth") || s.includes("token") || s.includes("unauthorized") || s.includes("forbidden")) {
      return "auth";
    }
    if (s.includes("domain") || s.includes("policy") || s.includes("permission") || s.includes("not allowed")) {
      return "policy";
    }
    if (s.includes("invalid") || s.includes("required") || s.includes("schema") || s.includes("parse")) {
      return "input";
    }
    if (s.includes("connector") || s.includes("not configured") || s.includes("refresh_token")) {
      return "connector";
    }
    return "unknown";
  }

  function manualFailureActionGuide(reasonSummary: string) {
    const category = classifyManualWorkflowFailureReason(reasonSummary);
    if (category === "auth") {
      return {
        label: "認証エラー",
        tone: "border-rose-300 bg-rose-100 text-rose-900",
        action: "Google/Slack連携の再接続を行い、資格情報の有効期限を確認してください。",
        href: "/app/integrations/google"
      };
    }
    if (category === "policy") {
      return {
        label: "ポリシー制約",
        tone: "border-amber-300 bg-amber-100 text-amber-900",
        action: "ポリシー条件・許可ドメイン・承認状態を確認し、入力値を修正してから再実行してください。",
        href: "/app/governance"
      };
    }
    if (category === "input") {
      return {
        label: "入力不整合",
        tone: "border-sky-300 bg-sky-100 text-sky-900",
        action: "対象タスクのドラフト内容（宛先・件名・本文）を見直し、必須項目を補って再実行してください。",
        href: "/app/tasks"
      };
    }
    if (category === "connector") {
      return {
        label: "コネクタ設定不足",
        tone: "border-fuchsia-300 bg-fuchsia-100 text-fuchsia-900",
        action: "コネクタ設定値を確認し、refresh token や送信元アカウントを更新してから再実行してください。",
        href: "/app/integrations/google"
      };
    }
    return {
      label: "要手動調査",
      tone: "border-slate-300 bg-slate-100 text-slate-800",
      action: "workflow run詳細の失敗ステップを確認し、再試行前に前提データ/権限を点検してください。",
      href: "/app/workflows/runs"
    };
  }

  function renderCaseControls(args: {
    kind: ExceptionKind;
    refId: string;
    taskId: string | null;
    taskLabel: string;
    existing: ExceptionCase | null;
  }) {
    const existing = args.existing;
    const guide = guidanceForKind({
      kind: args.kind,
      owner: existing?.owner_user_id ?? null,
      dueAt: existing?.due_at ?? null,
      taskLabel: args.taskLabel
    });
    return (
      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
        <form action={upsertExceptionCase}>
          <input type="hidden" name="kind" value={args.kind} />
          <input type="hidden" name="ref_id" value={args.refId} />
          <input type="hidden" name="task_id" value={args.taskId ?? ""} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-slate-600">状態</span>
              <select
                name="status"
                defaultValue={existing?.status ?? "open"}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              >
                <option value="open">未着手</option>
                <option value="in_progress">対応中</option>
                <option value="resolved">解決</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-600">担当者</span>
              <select
                name="owner_user_id"
                defaultValue={existing?.owner_user_id ?? ""}
                className="max-w-[220px] rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              >
                <option value="">未割当</option>
                {ownerUsers.map((userId) => (
                  <option key={userId} value={userId}>
                    {memberLabel(userId)}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="text"
              name="note"
              defaultValue={existing?.note ?? ""}
              placeholder="メモ"
              className="min-w-[180px] flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            />
            <label className="flex items-center gap-1">
              <span className="text-slate-600">期限</span>
              <input
                type="datetime-local"
                name="due_at"
                defaultValue={toDateTimeLocalValue(existing?.due_at ?? null)}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </label>
            <button type="submit" className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium">
              保存
            </button>
          </div>
        </form>
        {existing?.id ? (
          <div className="mt-2 border-t border-slate-200 pt-2">
            <form action={prepareExceptionRecoveryQuestion} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="kind" value={args.kind} />
              <input type="hidden" name="ref_id" value={args.refId} />
              <input type="hidden" name="task_label" value={args.taskLabel} />
              <input type="hidden" name="question" value={guide.question} />
              <input type="hidden" name="next_action" value={guide.nextAction} />
              <ConfirmSubmitButton
                label="回収質問テンプレを記録"
                pendingLabel="記録中..."
                confirmMessage="この回収質問テンプレをケース履歴へ記録し、対応中へ更新します。実行しますか？"
                className="rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
              />
              <span className="text-[11px] text-slate-500">未設定の期限は自動で24時間後に設定</span>
            </form>
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-slate-500">先に「保存」でケースを作成すると回収質問テンプレを記録できます。</p>
        )}
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-rose-900 p-6 text-white shadow-lg">
        <p className="text-xs uppercase tracking-[0.18em] text-rose-200">例外キュー</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">例外トリアージ</h1>
        <p className="mt-2 text-sm text-slate-200">失敗・滞留・ポリシーブロックを一箇所で確認し、優先対応できます。</p>
      </div>

      <StatusNotice ok={sp.ok} error={sp.error} />

      <form method="get" className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="ok" value="" />
          <input type="hidden" name="error" value="" />
          <label className="text-xs text-slate-700">
            担当者
            <select
              name="owner"
              defaultValue={selectedOwner}
              className="mt-1 block rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="all">すべて</option>
              <option value="unassigned">未割当</option>
              {ownerUsers.map((userId) => (
                <option key={userId} value={userId}>
                  {memberLabel(userId)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-700">
            ケース状態
            <select
              name="case_status"
              defaultValue={selectedCaseStatus}
              className="mt-1 block rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="all">すべて</option>
              <option value="open">未着手</option>
              <option value="in_progress">対応中</option>
              <option value="resolved">解決</option>
            </select>
          </label>
          <label className="text-xs text-slate-700">
            並び順
            <select
              name="sort"
              defaultValue={selectedSort}
              className="mt-1 block rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="priority_desc">優先度順</option>
              <option value="due_asc">期限が近い順</option>
              <option value="updated_desc">更新が新しい順</option>
            </select>
          </label>
          <label className="flex items-center gap-2 pb-1 text-xs text-slate-700">
            <input
              type="checkbox"
              name="overdue_only"
              value="1"
              defaultChecked={overdueOnly}
              className="h-4 w-4 rounded border-slate-300"
            />
            期限超過のみ
          </label>
          <label className="text-xs text-slate-700">
            表示プリセット
            <select
              name="view"
              defaultValue={selectedView}
              className="mt-1 block rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="all">すべて</option>
              <option value="overdue_unassigned">期限超過・未割当</option>
              <option value="my_open">自分担当の未解決</option>
            </select>
          </label>
          <label className="text-xs text-slate-700">
            出力件数
            <input
              type="number"
              name="export_limit"
              min={1}
              max={10000}
              defaultValue={selectedExportLimit}
              className="mt-1 block w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            />
          </label>
          <label className="text-xs text-slate-700">
            出力開始位置
            <input
              type="number"
              name="export_offset"
              min={0}
              defaultValue={selectedExportOffset}
              className="mt-1 block w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            />
          </label>
          <label className="flex items-center gap-2 pb-1 text-xs text-slate-700">
            <input type="hidden" name="include_payload" value="0" />
            <input
              type="checkbox"
              name="include_payload"
              value="1"
              defaultChecked={includePayload}
              className="h-4 w-4 rounded border-slate-300"
            />
            詳細JSONを含める
          </label>
          <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium">
            フィルタ適用
          </button>
          <a
            href={exportCsvHref}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800"
          >
            CSV出力
          </a>
          <a
            href={exportJsonHref}
            className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800"
          >
            JSON出力
          </a>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <Link
            href={`/app/operations/exceptions?view=all&sort=priority_desc&export_limit=${selectedExportLimit}&export_offset=${selectedExportOffset}&include_payload=${includePayload ? "1" : "0"}`}
            className="rounded-full border border-slate-300 px-2 py-0.5"
          >
            標準
          </Link>
          <Link
            href={`/app/operations/exceptions?view=overdue_unassigned&sort=due_asc&export_limit=${selectedExportLimit}&export_offset=${selectedExportOffset}&include_payload=${includePayload ? "1" : "0"}`}
            className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-rose-700"
          >
            期限超過/未割当
          </Link>
          <Link
            href={`/app/operations/exceptions?view=my_open&sort=updated_desc&export_limit=${selectedExportLimit}&export_offset=${selectedExportOffset}&include_payload=${includePayload ? "1" : "0"}`}
            className="rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-sky-700"
          >
            自分担当
          </Link>
        </div>
      </form>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">一括更新（選択ケース）</h2>
        <form action={bulkUpdateExceptionCases} className="mt-3 space-y-3">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {filteredUnresolvedCases.slice(0, 24).map((row) => (
              <label
                key={row.id}
                className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-2 text-xs"
              >
                <input type="checkbox" name="case_ids" value={row.id} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
                <span className="min-w-0">
                  <span className="block text-slate-800">
                    {caseKindLabel(row.kind)}
                  </span>
                  <span className="block text-slate-600">
                    {caseStatusLabel(row.status)} / {memberLabel(row.owner_user_id)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {filteredUnresolvedCases.length > 24 ? (
            <p className="text-xs text-slate-500">
              先頭24件のみ表示しています。フィルタで絞ってから一括更新してください。
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-700">
              状態
              <select name="status" defaultValue="" className="mt-1 block rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                <option value="">(変更しない)</option>
                <option value="open">未着手</option>
                <option value="in_progress">対応中</option>
                <option value="resolved">解決</option>
              </select>
            </label>
            <label className="text-xs text-slate-700">
              担当者
              <select name="owner_user_id" defaultValue="" className="mt-1 block rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                <option value="">未割当</option>
                {ownerUsers.map((userId) => (
                  <option key={userId} value={userId}>
                    {memberLabel(userId)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-700">
              期限
              <input
                type="datetime-local"
                name="due_at"
                className="mt-1 block rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </label>
            <label className="flex items-center gap-2 pb-1 text-xs text-slate-700">
              <input type="checkbox" name="clear_due" value="1" className="h-4 w-4 rounded border-slate-300" />
              期限をクリア
            </label>
            <ConfirmSubmitButton
              label="選択ケースを一括更新"
              pendingLabel="更新中..."
              confirmMessage="選択した例外ケースを一括更新します。実行しますか？"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium"
            />
          </div>
        </form>
      </section>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">総例外件数</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{totalExceptions}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">失敗アクション</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{filteredFailedActionsWithPriority.length}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <p className="text-xs text-amber-700">失敗ワークフロー</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{filteredFailedRunsWithPriority.length}</p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-xs text-sky-700">承認滞留</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{filteredStaleApprovalsWithPriority.length}</p>
        </div>
        <div className="rounded-xl border border-fuchsia-200 bg-fuchsia-50 p-4 shadow-sm">
          <p className="text-xs text-fuchsia-700">ポリシーブロック</p>
          <p className="mt-1 text-2xl font-semibold text-fuchsia-900">{filteredBlockedTasksWithPriority.length}</p>
        </div>
        <div className="rounded-xl border border-rose-300 bg-rose-100 p-4 shadow-sm">
          <p className="text-xs text-rose-700">手動対応失敗ラン</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{monitorManualWorkflowFailures.length}</p>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs text-rose-700">未解決ケース</p>
            <p className="mt-1 text-2xl font-semibold text-rose-900">{filteredUnresolvedCases.length}</p>
          </div>
          <div className="rounded-lg border border-rose-300 bg-rose-100 p-3">
            <p className="text-xs text-rose-700">期限超過ケース</p>
            <p className="mt-1 text-2xl font-semibold text-rose-900">{filteredOverdueCases.length}</p>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs text-amber-700">最大期限超過</p>
            <p className="mt-1 text-2xl font-semibold text-amber-900">
              {filteredMaxOverdueHours > 0 ? formatDaysFromHours(filteredMaxOverdueHours) : "-"}
            </p>
          </div>
        </div>

        <h3 className="mt-4 text-sm font-semibold text-slate-900">担当者別バックログ</h3>
        {filteredOwnerBacklogRows.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {filteredOwnerBacklogRows.slice(0, 12).map((row) => (
              <li key={row.owner} className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-slate-700">
                    {row.owner === "unassigned" ? "未割当" : memberLabel(row.owner)}
                  </p>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                      row.overdue > 0
                        ? "border-rose-300 bg-rose-100 text-rose-700"
                        : "border-slate-300 bg-slate-100 text-slate-700"
                    }`}
                  >
                    合計 {row.total}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  未着手 {row.open} / 対応中 {row.inProgress} / 期限超過 {row.overdue}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">未解決の例外ケースはありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">監視回収で手動対応判定された失敗</h2>
          <Link href="/app/monitor" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">
            監視履歴へ
          </Link>
        </div>
        {monitorManualWorkflowFailures.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {monitorManualWorkflowFailures.slice(0, 10).map((row) => (
              <li key={row.workflowRunId} className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
                {(() => {
                  const guide = manualFailureActionGuide(row.reasonSummary);
                  return (
                    <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/app/workflows/runs/${row.workflowRunId}`} className="font-medium text-rose-900 underline">
                    {workflowRunTaskTitleByRunId.get(row.workflowRunId) ?? "ワークフロー実行詳細"}
                  </Link>
                  <span className="text-xs text-rose-700">{new Date(row.createdAt).toLocaleString("ja-JP")}</span>
                </div>
                <p className="mt-1 text-xs text-rose-800">{row.reasonSummary}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${guide.tone}`}>{guide.label}</span>
                  <Link href={guide.href} className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50">
                    推奨導線を開く
                  </Link>
                </div>
                <p className="mt-1 text-xs text-slate-700">{guide.action}</p>
                    </>
                  );
                })()}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">監視回収で手動判定されたワークフロー失敗はありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">優先対応（Top 5）</h2>
          <div className="flex items-center gap-2">
            <form action={notifyExceptionCasesNow}>
              <ConfirmSubmitButton
                label="例外通知をSlack送信"
                pendingLabel="通知中..."
                confirmMessage="現在の例外ケースをSlackへ通知します。実行しますか？"
                className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
              />
            </form>
            <form action={retryTopFailedWorkflowRuns} className="flex items-center gap-2">
              <input type="hidden" name="limit" value="3" />
              <ConfirmSubmitButton
                label="失敗ワークフロー上位3件を一括再試行"
                pendingLabel="再試行中..."
                confirmMessage="失敗ワークフロー実行の上位3件を再試行します。実行しますか？"
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
              />
            </form>
          </div>
        </div>
        <ul className="mt-3 space-y-2">
          {[
            ...sortedFailedRunsWithPriority.slice(0, 2).map((item) => ({
              key: `run-${item.row.id}`,
              label: `ワークフロー失敗: ${item.task?.title ?? "関連タスク"}`,
              href: `/app/workflows/runs/${item.row.id}`,
              score: item.score,
              tone: item.tone
            })),
            ...sortedFailedActionsWithPriority.slice(0, 2).map((item) => ({
              key: `action-${item.row.id}`,
              label: `アクション失敗: ${item.task?.title ?? "関連タスク"}`,
              href: `/app/tasks/${item.row.task_id}`,
              score: item.score,
              tone: item.tone
            })),
            ...sortedStaleApprovalsWithPriority.slice(0, 1).map((item) => ({
              key: `approval-${item.row.id}`,
              label: `承認滞留 ${item.pendingHours}h: ${item.task?.title ?? "関連タスク"}`,
              href: `/app/tasks/${item.row.task_id}`,
              score: item.score,
              tone: item.tone
            }))
          ]
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map((item) => (
              <li key={item.key} className="flex items-center justify-between rounded-md border border-slate-200 p-3 text-sm">
                <Link href={item.href} className="text-slate-800 underline">
                  {item.label}
                </Link>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorityClass(item.tone)}`}>
                  P{item.score}
                </span>
              </li>
            ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">失敗アクション（最新50件）</h2>
        {sortedFailedActionsWithPriority.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {sortedFailedActionsWithPriority.map(({ row, task, score, tone }) => {
              const result = asObject(row.result_json);
              const error = typeof result?.error === "string" ? result.error : null;
              const exceptionCase = getCase("failed_action", row.id);
              const isOverdue =
                exceptionCase?.due_at !== null && exceptionCase?.due_at !== undefined
                  ? new Date(exceptionCase.due_at).getTime() < Date.now() && exceptionCase.status !== "resolved"
                  : false;
              return (
                <li
                  key={row.id}
                  className={`rounded-md border p-3 text-sm ${isOverdue ? "border-rose-300 bg-rose-50/40" : "border-slate-200"}`}
                >
                  <p className="mt-1 text-slate-900">{row.provider}/{row.action_type}</p>
                  <p className="text-xs text-slate-600">発生: {new Date(row.created_at).toLocaleString("ja-JP")}</p>
                  <p className="text-xs text-slate-700">
                    タスク: {task ? `${task.title} (${task.status})` : "関連タスク"}
                  </p>
                  <p className="mt-1">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorityClass(tone)}`}>
                      優先度 P{score}
                    </span>
                    {exceptionCase ? (
                      <span className="ml-2 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700">
                        {caseStatusLabel(exceptionCase.status)} / {memberLabel(exceptionCase.owner_user_id)}
                      </span>
                    ) : null}
                    {exceptionCase?.due_at ? (
                      <span className={`ml-2 rounded-full border px-2 py-0.5 text-xs ${isOverdue ? "border-rose-300 bg-rose-100 text-rose-700" : "border-slate-300 bg-white text-slate-700"}`}>
                        期限: {new Date(exceptionCase.due_at).toLocaleString("ja-JP")}
                      </span>
                    ) : null}
                  </p>
                  {error ? <p className="mt-1 text-xs text-rose-700">エラー: {error}</p> : null}
                  {renderGuidance({
                    kind: "failed_action",
                    owner: exceptionCase?.owner_user_id ?? null,
                    dueAt: exceptionCase?.due_at ?? null,
                    taskLabel: task?.title ?? "関連タスク"
                  })}
                  <div className="mt-2 flex gap-3 text-xs">
                    <Link href={`/app/tasks/${row.task_id}`} className="font-medium text-sky-700 underline">
                      タスクを開く
                    </Link>
                    <Link href={`/app/tasks/${row.task_id}/evidence`} className="font-medium text-slate-700 underline">
                      証跡
                    </Link>
                  </div>
                  {renderCaseControls({
                    kind: "failed_action",
                    refId: row.id,
                    taskId: row.task_id,
                    taskLabel: task?.title ?? "関連タスク",
                    existing: exceptionCase
                  })}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">失敗アクションはありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">失敗ワークフロー（最新30件）</h2>
          <form action={retryTopFailedWorkflowRuns} className="flex items-center gap-2">
            <input type="hidden" name="limit" value="5" />
            <ConfirmSubmitButton
              label="上位5件を一括再試行"
              pendingLabel="再試行中..."
              confirmMessage="失敗ワークフロー実行の上位5件を再試行します。実行しますか？"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            />
          </form>
        </div>
        {sortedFailedRunsWithPriority.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {sortedFailedRunsWithPriority.map(({ row, task, score, tone }) => {
              const exceptionCase = getCase("failed_workflow", row.id);
              const isOverdue =
                exceptionCase?.due_at !== null && exceptionCase?.due_at !== undefined
                  ? new Date(exceptionCase.due_at).getTime() < Date.now() && exceptionCase.status !== "resolved"
                  : false;
              return (
                <li
                  key={row.id}
                  className={`rounded-md border p-3 text-sm ${isOverdue ? "border-rose-300 bg-rose-50/40" : "border-slate-200"}`}
                >
                  <p className="mt-1 text-slate-900">ステップ: {row.current_step_key ?? "-"}</p>
                  <p className="text-xs text-slate-600">
                    終了: {row.finished_at ? new Date(row.finished_at).toLocaleString("ja-JP") : "-"}
                  </p>
                  <p className="text-xs text-slate-700">
                    タスク: {task ? `${task.title} (${task.status})` : "関連タスク"}
                  </p>
                  <p className="mt-1">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorityClass(tone)}`}>
                      優先度 P{score}
                    </span>
                    {exceptionCase ? (
                      <span className="ml-2 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700">
                        {caseStatusLabel(exceptionCase.status)} / {memberLabel(exceptionCase.owner_user_id)}
                      </span>
                    ) : null}
                    {exceptionCase?.due_at ? (
                      <span className={`ml-2 rounded-full border px-2 py-0.5 text-xs ${isOverdue ? "border-rose-300 bg-rose-100 text-rose-700" : "border-slate-300 bg-white text-slate-700"}`}>
                        期限: {new Date(exceptionCase.due_at).toLocaleString("ja-JP")}
                      </span>
                    ) : null}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs">
                    <Link href={`/app/workflows/runs/${row.id}`} className="font-medium text-sky-700 underline">
                      Run詳細
                    </Link>
                    <form action={retryWorkflowRunFromExceptions}>
                      <input type="hidden" name="workflow_run_id" value={row.id} />
                      <ConfirmSubmitButton
                        label="この場で再試行"
                        pendingLabel="再試行中..."
                        confirmMessage="このワークフロー実行を再試行します。実行しますか？"
                        className="font-medium text-emerald-700 underline"
                      />
                    </form>
                  </div>
                  {renderGuidance({
                    kind: "failed_workflow",
                    owner: exceptionCase?.owner_user_id ?? null,
                    dueAt: exceptionCase?.due_at ?? null,
                    taskLabel: task?.title ?? "関連タスク"
                  })}
                  {renderCaseControls({
                    kind: "failed_workflow",
                    refId: row.id,
                    taskId: row.task_id,
                    taskLabel: task?.title ?? "関連タスク",
                    existing: exceptionCase
                  })}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">失敗ワークフローはありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          長時間承認待ち（{pendingThresholdHours}h以上）
        </h2>
        {sortedStaleApprovalsWithPriority.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {sortedStaleApprovalsWithPriority.map(({ row, task, score, tone, pendingHours }) => {
              const exceptionCase = getCase("stale_approval", row.id);
              const isOverdue =
                exceptionCase?.due_at !== null && exceptionCase?.due_at !== undefined
                  ? new Date(exceptionCase.due_at).getTime() < Date.now() && exceptionCase.status !== "resolved"
                  : false;
              return (
                <li
                  key={row.id}
                  className={`rounded-md border p-3 text-sm ${isOverdue ? "border-rose-300 bg-rose-50/40" : "border-slate-200"}`}
                >
                  <p className="mt-1 text-slate-900">{task ? task.title : "関連タスク"}</p>
                  <p className="text-xs text-slate-600">
                    滞留: {pendingHours}h / 依頼者: {memberLabel(row.requested_by, "未設定")}
                  </p>
                  <p className="mt-1">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorityClass(tone)}`}>
                      優先度 P{score}
                    </span>
                    {exceptionCase ? (
                      <span className="ml-2 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700">
                        {caseStatusLabel(exceptionCase.status)} / {memberLabel(exceptionCase.owner_user_id)}
                      </span>
                    ) : null}
                    {exceptionCase?.due_at ? (
                      <span className={`ml-2 rounded-full border px-2 py-0.5 text-xs ${isOverdue ? "border-rose-300 bg-rose-100 text-rose-700" : "border-slate-300 bg-white text-slate-700"}`}>
                        期限: {new Date(exceptionCase.due_at).toLocaleString("ja-JP")}
                      </span>
                    ) : null}
                  </p>
                  <div className="mt-2 flex gap-3 text-xs">
                    <Link href="/app/approvals" className="font-medium text-sky-700 underline">
                      承認一覧へ
                    </Link>
                    <Link href={`/app/tasks/${row.task_id}`} className="font-medium text-slate-700 underline">
                      タスクを開く
                    </Link>
                  </div>
                  {renderGuidance({
                    kind: "stale_approval",
                    owner: exceptionCase?.owner_user_id ?? null,
                    dueAt: exceptionCase?.due_at ?? null,
                    taskLabel: task?.title ?? "関連タスク"
                  })}
                  {renderCaseControls({
                    kind: "stale_approval",
                    refId: row.id,
                    taskId: row.task_id,
                    taskLabel: task?.title ?? "関連タスク",
                    existing: exceptionCase
                  })}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">長時間承認待ちはありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">ポリシーブロックタスク（最新）</h2>
        {sortedBlockedTasksWithPriority.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {sortedBlockedTasksWithPriority.map(({ task, score, tone }) => {
              const exceptionCase = getCase("policy_block", task.id);
              const isOverdue =
                exceptionCase?.due_at !== null && exceptionCase?.due_at !== undefined
                  ? new Date(exceptionCase.due_at).getTime() < Date.now() && exceptionCase.status !== "resolved"
                  : false;
              return (
                <li
                  key={task.id}
                  className={`rounded-md border p-3 text-sm ${isOverdue ? "border-rose-300 bg-rose-50/40" : "border-slate-200"}`}
                >
                  <p className="text-slate-900">{task.title}</p>
                  <p className="text-xs text-slate-600">状態: {task.status}</p>
                  <p className="mt-1">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorityClass(tone)}`}>
                      優先度 P{score}
                    </span>
                    {exceptionCase ? (
                      <span className="ml-2 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700">
                        {caseStatusLabel(exceptionCase.status)} / {memberLabel(exceptionCase.owner_user_id)}
                      </span>
                    ) : null}
                    {exceptionCase?.due_at ? (
                      <span className={`ml-2 rounded-full border px-2 py-0.5 text-xs ${isOverdue ? "border-rose-300 bg-rose-100 text-rose-700" : "border-slate-300 bg-white text-slate-700"}`}>
                        期限: {new Date(exceptionCase.due_at).toLocaleString("ja-JP")}
                      </span>
                    ) : null}
                  </p>
                  <div className="mt-2 flex gap-3 text-xs">
                    <Link href={`/app/tasks/${task.id}`} className="font-medium text-sky-700 underline">
                      タスクを開く
                    </Link>
                    <Link href={`/app/tasks/${task.id}/evidence`} className="font-medium text-slate-700 underline">
                      証跡
                    </Link>
                  </div>
                  {renderGuidance({
                    kind: "policy_block",
                    owner: exceptionCase?.owner_user_id ?? null,
                    dueAt: exceptionCase?.due_at ?? null,
                    taskLabel: task.title
                  })}
                  {renderCaseControls({
                    kind: "policy_block",
                    refId: task.id,
                    taskId: task.id,
                    taskLabel: task.title,
                    existing: exceptionCase
                  })}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">ポリシーブロック中のタスクは見つかりません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">例外ケースイベント（最新50件）</h2>
        {exceptionCaseEvents.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {exceptionCaseEvents.map((event) => {
              const relatedCase = exceptionCases.find((row) => row.id === event.exception_case_id) ?? null;
              const isEscalated = event.event_type === "CASE_ESCALATED";
              const isAutoAssigned = event.event_type === "CASE_AUTO_ASSIGNED";
              const isRecoveryQuestionPrepared = event.event_type === "CASE_RECOVERY_QUESTION_PREPARED";
              const payload = asObject(event.payload_json);
              return (
                <li key={event.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="mt-1 text-slate-900">
                    {event.event_type}
                    {isEscalated ? (
                      <span className="ml-2 rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 text-xs text-rose-700">
                        エスカレーション
                      </span>
                    ) : null}
                    {isAutoAssigned ? (
                      <span className="ml-2 rounded-full border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                        自動アサイン
                      </span>
                    ) : null}
                    {isRecoveryQuestionPrepared ? (
                      <span className="ml-2 rounded-full border border-indigo-300 bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700">
                        回収質問準備
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-slate-600">
                    時刻: {new Date(event.created_at).toLocaleString("ja-JP")} / 実行者: {memberLabel(event.actor_user_id, "システム")}
                  </p>
                  <p className="text-xs text-slate-700">
                    種別: {relatedCase ? relatedCase.kind : "不明"}
                  </p>
                  {isRecoveryQuestionPrepared ? (
                    <p className="mt-1 text-xs text-indigo-700">
                      回収質問: {typeof payload?.question === "string" ? payload.question : "（未設定）"}
                    </p>
                  ) : null}
                  <details className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
                    <summary className="cursor-pointer text-xs text-slate-700">ペイロードJSON</summary>
                    <pre className="mt-2 overflow-x-auto text-xs text-slate-700">
                      {toRedactedJson(event.payload_json)}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">例外ケースイベントはまだありません。</p>
        )}
      </section>
    </section>
  );
}
