import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import {
  decideApproval,
  sendHighRiskInsufficientRemindersNow,
  resendSelectedApprovalSlackReminders,
  resendApprovalSlackReminder,
  runGuardedAutoReminderNow,
  sendStaleApprovalRemindersNow
} from "@/app/app/approvals/actions";
import { getGovernanceSettings } from "@/lib/governance/evaluate";
import { getHighRiskThreshold, getRequiredApprovalCountForRisk } from "@/lib/governance/guardrails";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ApprovalsPageProps = {
  searchParams?: Promise<{
    error?: string;
    ok?: string;
    stale_only?: string;
    high_risk_only?: string;
    blocked_only?: string;
    sort?: string;
    window?: string;
    ref_from?: string;
    ref_intent?: string;
    ref_ts?: string;
  }>;
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

type ApprovalBlockedEventRow = {
  task_id: string;
  actor_id: string | null;
  created_at: string;
  payload_json: unknown;
};

function parseObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseDraftRisksFromModelPayload(payload: unknown) {
  const obj = parseObject(payload);
  const output = parseObject(obj?.output);
  if (!output || !Array.isArray(output.risks)) return [];
  return output.risks.filter((item): item is string => typeof item === "string");
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function resolveWindowHours(windowValue: string) {
  if (windowValue === "24h") return 24;
  if (windowValue === "30d") return 24 * 30;
  return 24 * 7;
}

function windowLabel(value: "24h" | "7d" | "30d") {
  if (value === "24h") return "24時間";
  if (value === "30d") return "30日";
  return "7日";
}

function reminderSourceLabel(source: string) {
  if (source === "manual") return "手動";
  if (source === "cron") return "定期実行";
  return "不明";
}

function blockedReasonLabel(reasonCode: string) {
  if (reasonCode === "sod_initiator_approver_conflict") return "職務分掌: 起票者は自身の承認不可";
  return reasonCode || "不明";
}

export default async function ApprovalsPage({ searchParams }: ApprovalsPageProps) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const governanceSettings = await getGovernanceSettings({ supabase, orgId });
  const sp = searchParams ? await searchParams : {};
  const refFrom = typeof sp.ref_from === "string" ? sp.ref_from : "";
  const refIntent = typeof sp.ref_intent === "string" ? sp.ref_intent : "";
  const refTs = typeof sp.ref_ts === "string" ? sp.ref_ts : "";
  const windowFilter = sp.window === "24h" || sp.window === "30d" ? sp.window : "7d";
  const windowHours = resolveWindowHours(windowFilter);
  const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const staleHours = Number(process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6");
  const staleOnly = sp.stale_only === "1";
  const highRiskOnly = sp.high_risk_only === "1";
  const blockedOnly = sp.blocked_only === "1";
  const sort = sp.sort === "newest" ? "newest" : "oldest";
  const hasActiveFilters = staleOnly || highRiskOnly || blockedOnly || sort !== "oldest" || windowFilter !== "7d";
  const filterSummary = [
    staleOnly ? "SLA超過のみ" : null,
    highRiskOnly ? "高リスク承認不足のみ" : null,
    blockedOnly ? "承認ブロック発生タスクのみ" : null,
    sort === "newest" ? "並び順=新しい順" : null,
    windowFilter !== "7d" ? `期間=${windowLabel(windowFilter)}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const currentFilterParams = new URLSearchParams();
  if (staleOnly) currentFilterParams.set("stale_only", "1");
  if (highRiskOnly) currentFilterParams.set("high_risk_only", "1");
  if (blockedOnly) currentFilterParams.set("blocked_only", "1");
  if (sort !== "oldest") currentFilterParams.set("sort", sort);
  if (windowFilter !== "7d") currentFilterParams.set("window", windowFilter);
  const currentFilterPath =
    currentFilterParams.size > 0 ? `/app/approvals?${currentFilterParams.toString()}` : "/app/approvals";
  const autoMinStaleRaw = Number.parseInt(process.env.APPROVAL_REMINDER_AUTO_MIN_STALE ?? "3", 10);
  const autoMinStale = Number.isNaN(autoMinStaleRaw) ? 3 : Math.max(1, Math.min(1000, autoMinStaleRaw));

  const [{ data: approvals, error }, { data: weeklyApprovals, error: weeklyError }, reminderEventsRes, autoRunEventsRes, blockedEventsRes] =
    await Promise.all([
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
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("task_events")
      .select("task_id, created_at, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "SLACK_APPROVAL_POSTED")
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("task_events")
      .select("task_id, created_at, event_type, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["APPROVAL_REMINDER_AUTO_RUN", "APPROVAL_REMINDER_AUTO_SKIPPED"])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("task_events")
      .select("task_id, actor_id, created_at, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "APPROVAL_BLOCKED")
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(500)
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
  if (blockedEventsRes.error) {
    throw new Error(`Failed to load blocked approval events: ${blockedEventsRes.error.message}`);
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
  const blockedEvents = ((blockedEventsRes.data ?? []) as ApprovalBlockedEventRow[]).map((row) => {
    const payload = parseObject(row.payload_json);
    const reasonCode = typeof payload?.reason_code === "string" ? payload.reason_code : "";
    const source = typeof payload?.source === "string" ? payload.source : "unknown";
    return {
      taskId: row.task_id,
      actorId: row.actor_id,
      createdAt: row.created_at,
      reasonCode,
      source
    };
  });
  const blockedTaskIds = new Set(blockedEvents.map((row) => row.taskId));
  const sodBlockedCount = blockedEvents.filter((row) => row.reasonCode === "sod_initiator_approver_conflict").length;
  const blockedTotalCount = blockedEvents.length;
  const blockedRecent = blockedEvents.slice(0, 10);
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
  const trendAction =
    autoStaleDelta === null
      ? "推奨: まず推奨閾値で1回実行して基準値を作成。"
      : autoStaleDelta > 0
        ? "推奨: 悪化傾向のため閾値を下げて即実行し、承認滞留を先に圧縮。"
        : autoStaleDelta === 0
          ? "推奨: 横ばいのため現行閾値維持で実行し、担当者アサインを見直し。"
          : "推奨: 改善傾向。現行閾値を維持し、過剰通知を避ける。";
  const suggestedUrgentMinStale =
    autoStaleDelta !== null && autoStaleDelta > 0
      ? Math.max(1, Math.min(suggestedOneOffMinStale, Math.max(1, currentStalePendingCount - 1)))
      : suggestedOneOffMinStale;
  const taskIds = Array.from(
    new Set([...pendingApprovals.map((approval) => approval.task_id), ...reminderEvents.map((row) => row.taskId), ...blockedEvents.map((row) => row.taskId)])
  );
  const approvedCount = weeklyRows.filter((row) => row.status === "approved").length;
  const rejectedCount = weeklyRows.filter((row) => row.status === "rejected").length;
  const pendingCount = weeklyRows.filter((row) => row.status === "pending").length;
  const maxCount = Math.max(1, approvedCount, rejectedCount, pendingCount);

  let taskTitleById = new Map<string, string>();
  let taskCreatorById = new Map<string, string | null>();
  let allMemberUserIds: string[] = [];
  let memberDisplayNameByUserId = new Map<string, string>();
  const highRiskThreshold = getHighRiskThreshold();
  if (taskIds.length > 0) {
    const [tasksRes, membersRes, profilesRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, title, created_by_user_id")
        .in("id", taskIds)
        .eq("org_id", orgId),
      supabase.from("memberships").select("user_id").eq("org_id", orgId).limit(500),
      supabase.from("user_profiles").select("user_id, display_name").eq("org_id", orgId).limit(500)
    ]);

    if (tasksRes.error) {
      throw new Error(`Failed to load approval tasks: ${tasksRes.error.message}`);
    }
    if (membersRes.error) {
      throw new Error(`Failed to load members: ${membersRes.error.message}`);
    }
    if (profilesRes.error && !isMissingTableError(profilesRes.error.message, "user_profiles")) {
      throw new Error(`Failed to load user profiles: ${profilesRes.error.message}`);
    }

    const tasks = tasksRes.data ?? [];
    taskTitleById = new Map<string, string>((tasks ?? []).map((task) => [task.id as string, task.title as string]));
    taskCreatorById = new Map<string, string | null>(
      (tasks ?? []).map((task) => [task.id as string, (task.created_by_user_id as string | null | undefined) ?? null])
    );
    allMemberUserIds = (membersRes.data ?? [])
      .map((row) => (row.user_id as string | null | undefined) ?? null)
      .filter((value): value is string => Boolean(value));
    memberDisplayNameByUserId = new Map(
      ((profilesRes.data ?? []) as Array<{ user_id: string; display_name: string | null }>)
        .map((row) => [row.user_id, (row.display_name ?? "").trim()] as const)
        .filter((entry) => entry[1].length > 0)
    );
  }

  let riskScoreByTaskId = new Map<string, number>();
  let policyByTaskId = new Map<string, "pass" | "warn" | "block">();
  let draftRiskCountByTaskId = new Map<string, number>();
  let approvedDistinctByTaskId = new Map<string, number>();
  let approvedApproversByTaskId = new Map<string, Set<string>>();
  if (taskIds.length > 0) {
    const [riskRes, policyEventRes, modelEventRes, approvedRes] = await Promise.all([
      supabase
        .from("risk_assessments")
        .select("task_id, risk_score, created_at")
        .eq("org_id", orgId)
        .in("task_id", taskIds)
        .order("created_at", { ascending: false })
        .limit(2000),
      supabase
        .from("task_events")
        .select("task_id, payload_json, created_at")
        .eq("org_id", orgId)
        .in("task_id", taskIds)
        .eq("event_type", "POLICY_CHECKED")
        .order("created_at", { ascending: false })
        .limit(2000),
      supabase
        .from("task_events")
        .select("task_id, payload_json, created_at")
        .eq("org_id", orgId)
        .in("task_id", taskIds)
        .eq("event_type", "MODEL_INFERRED")
        .order("created_at", { ascending: false })
        .limit(2000),
      supabase
        .from("approvals")
        .select("task_id, approver_user_id")
        .eq("org_id", orgId)
        .in("task_id", taskIds)
        .eq("status", "approved")
    ]);
    if (riskRes.error) throw new Error(`Failed to load risk assessments: ${riskRes.error.message}`);
    if (policyEventRes.error) throw new Error(`Failed to load policy events: ${policyEventRes.error.message}`);
    if (modelEventRes.error) throw new Error(`Failed to load model events: ${modelEventRes.error.message}`);
    if (approvedRes.error) throw new Error(`Failed to load approved approvals: ${approvedRes.error.message}`);

    for (const row of riskRes.data ?? []) {
      const taskId = row.task_id as string;
      if (!taskId || riskScoreByTaskId.has(taskId)) continue;
      const score = Number(row.risk_score ?? NaN);
      if (Number.isFinite(score)) {
        riskScoreByTaskId.set(taskId, Math.max(0, Math.min(100, Math.round(score))));
      }
    }

    for (const row of policyEventRes.data ?? []) {
      const taskId = row.task_id as string;
      if (!taskId || policyByTaskId.has(taskId)) continue;
      const payload = parseObject(row.payload_json);
      const status = payload?.status;
      if (status === "pass" || status === "warn" || status === "block") {
        policyByTaskId.set(taskId, status);
      }
    }

    for (const row of modelEventRes.data ?? []) {
      const taskId = row.task_id as string;
      if (!taskId || draftRiskCountByTaskId.has(taskId)) continue;
      draftRiskCountByTaskId.set(taskId, parseDraftRisksFromModelPayload(row.payload_json).length);
    }

    const approversByTaskId = new Map<string, Set<string>>();
    for (const row of approvedRes.data ?? []) {
      const taskId = row.task_id as string;
      const approver = (row.approver_user_id as string | null | undefined) ?? null;
      if (!taskId || !approver) continue;
      const creator = taskCreatorById.get(taskId) ?? null;
      if (creator && approver === creator) continue;
      const set = approversByTaskId.get(taskId) ?? new Set<string>();
      set.add(approver);
      approversByTaskId.set(taskId, set);
    }
    approvedDistinctByTaskId = new Map(
      Array.from(approversByTaskId.entries()).map(([taskId, set]) => [taskId, set.size])
    );
    approvedApproversByTaskId = approversByTaskId;
  }

  const enrichedApprovals = filteredApprovals
    .map((approval) => {
      const taskId = approval.task_id;
      const policy = policyByTaskId.get(taskId) ?? "pass";
      const draftRiskCount = draftRiskCountByTaskId.get(taskId) ?? 0;
      const riskScore =
        riskScoreByTaskId.get(taskId) ??
        Math.min(
          100,
          20 + (policy === "block" ? 50 : policy === "warn" ? 15 : 0) + Math.min(20, draftRiskCount * 5)
        );
      const requiredApprovals = getRequiredApprovalCountForRisk(riskScore);
      const approvedDistinctCount = approvedDistinctByTaskId.get(taskId) ?? 0;
      const approvalGap = Math.max(0, requiredApprovals - approvedDistinctCount);
      const creatorUserId = taskCreatorById.get(taskId) ?? null;
      const approvedSet = approvedApproversByTaskId.get(taskId) ?? new Set<string>();
      const candidateUserIds = allMemberUserIds.filter(
        (userId) => userId !== creatorUserId && !approvedSet.has(userId)
      );
      const displayLimit = Math.max(3, approvalGap);
      const suggestedApprovers = candidateUserIds.slice(0, displayLimit).map(
        (userId) => memberDisplayNameByUserId.get(userId) ?? "メンバー"
      );
      const suggestedApproverOverflow = Math.max(0, candidateUserIds.length - displayLimit);
      return {
        approval,
        riskScore,
        requiredApprovals,
        approvedDistinctCount,
        approvalGap,
        suggestedApprovers,
        suggestedApproverOverflow
      };
    })
    .filter((row) => {
      if (!highRiskOnly) return true;
      return row.requiredApprovals > 0 && row.approvalGap > 0;
    })
    .filter((row) => {
      if (!blockedOnly) return true;
      return blockedTaskIds.has(row.approval.task_id);
    });

  const highlightedApprovalId = (() => {
    if (refTs) {
      const exact = enrichedApprovals.find((row) => row.approval.created_at === refTs);
      if (exact) return exact.approval.id;
    }
    if (refIntent === "request_approval" || refIntent === "decide_approval" || refIntent === "bulk_decide_approvals") {
      return enrichedApprovals[0]?.approval.id ?? null;
    }
    return null;
  })();
  const highRiskInsufficientCount = enrichedApprovals.filter((row) => row.requiredApprovals > 0 && row.approvalGap > 0).length;

  const chartRows = [
    { key: "approved", label: "承認", count: approvedCount, color: "bg-emerald-500" },
    { key: "rejected", label: "却下", count: rejectedCount, color: "bg-rose-500" },
    { key: "pending", label: "保留", count: pendingCount, color: "bg-amber-500" }
  ];

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">承認</h1>
      <p className="mt-2 text-sm text-slate-600">組織内の保留中承認です。</p>

      <StatusNotice ok={sp.ok} error={sp.error} className="mt-4" />
      {refFrom || refIntent || refTs ? (
        <div className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
          参照コンテキスト: {refFrom || "unknown"}
          {refIntent ? ` / ${refIntent}` : ""}
          {refTs ? ` / ${new Date(refTs).toLocaleString("ja-JP")}` : ""}
        </div>
      ) : null}

      <details open={hasActiveFilters} className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
        <summary className="cursor-pointer list-none font-semibold text-slate-700">絞り込み・再通知操作</summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
            <label className="inline-flex items-center gap-2">
              期間
              <select name="window" defaultValue={windowFilter} className="rounded-md border border-slate-300 px-2 py-1">
                <option value="24h">24時間</option>
                <option value="7d">7日</option>
                <option value="30d">30日</option>
              </select>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                name="high_risk_only"
                value="1"
                defaultChecked={highRiskOnly}
                className="h-4 w-4 rounded border-slate-300"
              />
              高リスク承認不足のみ
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                name="blocked_only"
                value="1"
                defaultChecked={blockedOnly}
                className="h-4 w-4 rounded border-slate-300"
              />
              承認ブロック発生タスクのみ
            </label>
            <button type="submit" className="rounded-md border border-slate-300 bg-white px-2 py-1">
              適用
            </button>
          </form>
          <CopyFilterLinkButton path={currentFilterPath} />
          {hasActiveFilters ? (
            <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">条件付き表示</span>
          ) : null}
          <form action={sendStaleApprovalRemindersNow}>
            <input type="hidden" name="window" value={windowFilter} />
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <ConfirmSubmitButton
              label="SLA超過をSlack再通知"
              pendingLabel="再通知中..."
              confirmMessage="SLA超過の承認待ちをSlackへ再通知します。実行しますか？"
              className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-sky-700 hover:bg-sky-100"
            />
          </form>
          <form action={sendHighRiskInsufficientRemindersNow}>
            <input type="hidden" name="window" value={windowFilter} />
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <ConfirmSubmitButton
              label="高リスク承認不足を再通知"
              pendingLabel="再通知中..."
              confirmMessage="高リスクで承認不足の保留承認をSlackへ再通知します。実行しますか？"
              className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-rose-700 hover:bg-rose-100"
            />
          </form>
        </div>
        {hasActiveFilters ? <p className="mt-2 text-xs text-slate-600">{filterSummary}</p> : null}
      </details>
      <form action={resendSelectedApprovalSlackReminders} id="bulk-approval-remind-form" className="rounded-md border border-sky-200 bg-sky-50 p-3">
        <input type="hidden" name="window" value={windowFilter} />
        <input type="hidden" name="return_to" value={currentFilterPath} />
        <div className="flex flex-wrap items-center gap-2">
          <ConfirmSubmitButton
            label="選択承認をSlack一括再通知"
            pendingLabel="再通知中..."
            confirmMessage="選択した保留承認をSlackへ再通知します。実行しますか？"
            className="rounded-md border border-sky-300 bg-white px-2 py-1 text-xs text-sky-700 hover:bg-sky-100"
          />
          <span className="text-xs text-sky-800">各カードのチェック項目で対象を選択</span>
        </div>
      </form>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">{windowLabel(windowFilter)} 保留</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{pendingCount}</p>
        </div>
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">{windowLabel(windowFilter)} 承認</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{approvedCount}</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${rejectedCount > 0 ? "border-rose-300 bg-rose-100" : "border-rose-200 bg-rose-50"}`}>
          <p className="text-rose-700">{windowLabel(windowFilter)} 却下</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{rejectedCount}</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${highRiskInsufficientCount > 0 ? "border-rose-300 bg-rose-100" : "border-slate-200 bg-slate-50"}`}>
          <p className="text-slate-700">高リスク承認不足</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{highRiskInsufficientCount}</p>
          <p className="mt-1 text-[11px] text-slate-600">threshold={highRiskThreshold}</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${blockedTotalCount > 0 ? "border-amber-300 bg-amber-100" : "border-slate-200 bg-slate-50"}`}>
          <p className="text-slate-700">承認ブロック（合計）</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{blockedTotalCount}</p>
          <p className="mt-1 text-[11px] text-slate-600">{windowLabel(windowFilter)} / APPROVAL_BLOCKED</p>
        </div>
        <div className={`rounded-md border p-3 text-sm ${sodBlockedCount > 0 ? "border-rose-300 bg-rose-100" : "border-slate-200 bg-slate-50"}`}>
          <p className="text-slate-700">SoDブロック</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{sodBlockedCount}</p>
          <p className="mt-1 text-[11px] text-slate-600">起票者≠承認者違反</p>
        </div>
      </div>

      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-amber-900">承認ブロック履歴（{windowLabel(windowFilter)}）</p>
          <span className="text-xs text-amber-800">APPROVAL_BLOCKED</span>
        </div>
        {blockedRecent.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {blockedRecent.map((event, idx) => {
              const actorName =
                event.actorId && memberDisplayNameByUserId.has(event.actorId)
                  ? memberDisplayNameByUserId.get(event.actorId)
                  : event.actorId
                    ? "メンバー"
                    : "system";
              return (
                <li key={`${event.taskId}-${event.createdAt}-${idx}`} className="rounded-md border border-amber-200 bg-white p-2 text-xs text-slate-700">
                  <p className="font-medium text-slate-900">
                    <Link href={`/app/tasks/${event.taskId}`} className="underline">
                      {taskTitleById.get(event.taskId) ?? "タスク"}
                    </Link>
                  </p>
                  <p className="mt-1 text-slate-600">
                    {new Date(event.createdAt).toLocaleString("ja-JP")} | {blockedReasonLabel(event.reasonCode)}
                  </p>
                  <p className="mt-1 text-slate-500">実行者: {actorName ?? "不明"} / source: {event.source}</p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-amber-900">直近{windowLabel(windowFilter)}の承認ブロックはありません。</p>
        )}
      </section>

      <section className="rounded-xl border border-sky-200 bg-sky-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-sky-900">リマインド実績（{windowLabel(windowFilter)}）</p>
          <span className="text-xs text-sky-800">SLACK_APPROVAL_POSTED / reminder=true</span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div className="rounded-md border border-sky-200 bg-white p-3">
            <p className="text-xs text-sky-700">送信総数</p>
            <p className="mt-1 text-xl font-semibold text-sky-900">{reminderTotal}</p>
          </div>
          <div className="rounded-md border border-sky-200 bg-white p-3">
            <p className="text-xs text-sky-700">手動</p>
            <p className="mt-1 text-xl font-semibold text-sky-900">{reminderManualCount}</p>
          </div>
          <div className="rounded-md border border-sky-200 bg-white p-3">
            <p className="text-xs text-sky-700">定期実行</p>
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
                    {taskTitleById.get(event.taskId) ?? "タスク"}
                  </Link>
                </p>
                <p className="mt-1 text-slate-500">
                  {new Date(event.createdAt).toLocaleString("ja-JP")} | 起点: {reminderSourceLabel(event.source)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-sky-900">直近{windowLabel(windowFilter)}のリマインド送信はありません。</p>
        )}
      </section>

      <section className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-indigo-900">Auto Guard 状態（{windowLabel(windowFilter)}）</p>
          <span className="text-xs text-indigo-800">/api/approvals/reminders/auto</span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div className="rounded-md border border-indigo-200 bg-white p-3">
            <p className="text-xs text-indigo-700">ガード閾値</p>
            <p className="mt-1 text-xl font-semibold text-indigo-900">{autoMinStale}</p>
          </div>
          <div className="rounded-md border border-indigo-200 bg-white p-3">
            <p className="text-xs text-indigo-700">現在の滞留承認数</p>
            <p className={`mt-1 text-xl font-semibold ${currentStalePendingCount >= autoMinStale ? "text-rose-700" : "text-indigo-900"}`}>
              {currentStalePendingCount}
            </p>
          </div>
          <div className="rounded-md border border-indigo-200 bg-white p-3">
            <p className="text-xs text-indigo-700">自動実行回数</p>
            <p className="mt-1 text-xl font-semibold text-indigo-900">{autoSentRuns}</p>
          </div>
          <div className="rounded-md border border-indigo-200 bg-white p-3">
            <p className="text-xs text-indigo-700">自動スキップ回数</p>
            <p className="mt-1 text-xl font-semibold text-indigo-900">{autoSkippedRuns}</p>
          </div>
        </div>
        {latestAutoEvent ? (
          <div className="mt-3 rounded-md border border-indigo-200 bg-white p-3 text-xs text-slate-700">
            <p className="font-medium text-indigo-900">直近 auto 実行結果</p>
            <p className="mt-1 text-slate-600">
              {new Date(latestAutoEvent.created_at).toLocaleString("ja-JP")} | {latestAutoEvent.event_type}
            </p>
            <p className="mt-1 text-slate-600">
              滞留件数={String(latestAutoPayload?.stale_pending_count ?? "-")} 閾値={String(latestAutoPayload?.threshold ?? autoMinStale)} 理由=
              {String(latestAutoPayload?.reason ?? "-")} 送信件数={String(latestAutoPayload?.sent_count ?? 0)}
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
            <p className="mt-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-900">{trendAction}</p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-indigo-900">直近{windowLabel(windowFilter)}の auto 実行ログはありません。</p>
        )}
        <p className="mt-3 text-xs text-indigo-900">
          推奨閾値: <span className="font-semibold">{suggestedOneOffMinStale}</span>
          （現在の滞留承認件数 {currentStalePendingCount} に基づく）
        </p>
        <form action={runGuardedAutoReminderNow} className="mt-2">
          <input type="hidden" name="window" value={windowFilter} />
          <input type="hidden" name="return_to" value={currentFilterPath} />
          <input type="hidden" name="min_stale" value={String(suggestedOneOffMinStale)} />
          <ConfirmSubmitButton
            label={`推奨値(${suggestedOneOffMinStale})で即実行`}
            pendingLabel="実行中..."
            confirmMessage={`推奨閾値 ${suggestedOneOffMinStale} でガード付き再通知を実行します。よろしいですか？`}
            className="rounded-md border border-indigo-300 bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-800 hover:bg-indigo-200"
          />
        </form>
        {suggestedUrgentMinStale !== suggestedOneOffMinStale ? (
          <form action={runGuardedAutoReminderNow} className="mt-2">
            <input type="hidden" name="window" value={windowFilter} />
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <input type="hidden" name="min_stale" value={String(suggestedUrgentMinStale)} />
            <ConfirmSubmitButton
              label={`悪化対応: 閾値${suggestedUrgentMinStale}で即実行`}
              pendingLabel="実行中..."
              confirmMessage={`悪化傾向に対処するため、閾値 ${suggestedUrgentMinStale} で再通知を実行します。よろしいですか？`}
              className="rounded-md border border-rose-300 bg-rose-100 px-2 py-1 text-xs font-medium text-rose-800 hover:bg-rose-200"
            />
          </form>
        ) : null}
        <form action={runGuardedAutoReminderNow} className="mt-3 rounded-md border border-indigo-200 bg-white p-3">
          <input type="hidden" name="window" value={windowFilter} />
          <input type="hidden" name="return_to" value={currentFilterPath} />
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
          <p className="text-sm font-medium text-slate-700">{windowLabel(windowFilter)} ステータス分布（縦棒）</p>
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

      {enrichedApprovals.length > 0 ? (
        <ul className="mt-5 space-y-4">
          {enrichedApprovals.map((row) => {
            const approval = row.approval;
            const taskCreatorId = taskCreatorById.get(approval.task_id) ?? null;
            const isSodBlocked =
              governanceSettings.enforceInitiatorApproverSeparation &&
              taskCreatorId !== null &&
              taskCreatorId === userId;
            const isRef = highlightedApprovalId !== null && approval.id === highlightedApprovalId;
            return (
            <li
              key={approval.id}
              id={isRef ? "ref-target" : undefined}
              className={`rounded-md border p-4 ${
                isRef ? "border-indigo-300 bg-indigo-50/50 ring-1 ring-indigo-200" : "border-amber-200 bg-amber-50/30"
              }`}
            >
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
                    {taskTitleById.get(approval.task_id) ?? "タスク"}
                  </Link>
                </p>
                <p className="text-xs text-slate-500">依頼日時 {new Date(approval.created_at).toLocaleString("ja-JP")}</p>
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
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
                    row.approvalGap > 0
                      ? "border-rose-300 bg-rose-50 text-rose-700"
                      : "border-emerald-300 bg-emerald-50 text-emerald-700"
                  }`}
                >
                  リスク={row.riskScore} / 承認 {row.approvedDistinctCount}/{row.requiredApprovals}
                </span>
              </div>
              {row.approvalGap > 0 ? (
                <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                  <p>追加で {row.approvalGap} 名の承認が必要です。</p>
                  {row.suggestedApprovers.length > 0 ? (
                    <p className="mt-1">
                      候補: {row.suggestedApprovers.join(" / ")}
                      {row.suggestedApproverOverflow > 0 ? ` ほか${row.suggestedApproverOverflow}名` : ""}
                    </p>
                  ) : (
                    <p className="mt-1">候補が不足しています。メンバー招待または担当体制を確認してください。</p>
                  )}
                </div>
              ) : null}

              <form action={decideApproval} className="mt-3 flex flex-col gap-3 md:flex-row md:items-center">
                <input type="hidden" name="window" value={windowFilter} />
                <input type="hidden" name="return_to" value={currentFilterPath} />
                <input type="hidden" name="approval_id" value={approval.id} />
                <input
                  type="text"
                  name="reason"
                  placeholder="理由（任意）"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm md:max-w-md"
                />
                <div className="flex gap-2">
                  {isSodBlocked ? (
                    <button
                      type="button"
                      disabled
                      className="cursor-not-allowed rounded-md bg-slate-300 px-3 py-2 text-sm text-white opacity-70"
                    >
                      承認不可（起票者）
                    </button>
                  ) : (
                    <ConfirmSubmitButton
                      name="decision"
                      value="approved"
                      label="承認"
                      pendingLabel="処理中..."
                      confirmMessage="この承認を承認に更新します。実行しますか？"
                      className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600"
                    />
                  )}
                  <ConfirmSubmitButton
                    name="decision"
                    value="rejected"
                    label="却下"
                    pendingLabel="処理中..."
                    confirmMessage="この承認を却下に更新します。実行しますか？"
                    className="rounded-md bg-rose-700 px-3 py-2 text-sm text-white hover:bg-rose-600"
                  />
                </div>
              </form>
              {isSodBlocked ? (
                <p className="mt-2 text-xs text-slate-600">
                  職務分掌ポリシーにより、起票者は自分のタスクを承認できません。
                </p>
              ) : null}
              <form action={resendApprovalSlackReminder} className="mt-2">
                <input type="hidden" name="window" value={windowFilter} />
                <input type="hidden" name="return_to" value={currentFilterPath} />
                <input type="hidden" name="approval_id" value={approval.id} />
                <ConfirmSubmitButton
                  label="Slackに再通知"
                  pendingLabel="再通知中..."
                  confirmMessage="この承認依頼をSlackに再通知します。実行しますか？"
                  className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-700 hover:bg-sky-100"
                />
              </form>
            </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-slate-600">
          {highRiskOnly
            ? "高リスク承認不足の保留承認はありません。"
            : staleOnly
              ? `SLA超過（${staleHours}時間以上）の保留承認はありません。`
              : "保留中の承認はありません。"}
        </p>
      )}
    </section>
  );
}
