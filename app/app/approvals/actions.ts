"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sendApprovalReminders } from "@/lib/approvals/reminders";
import { resolveSafeAppReturnTo, withMessageOnReturnTo } from "@/lib/app/returnTo";
import { decideApprovalShared } from "@/lib/approvals/decide";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { getRequiredApprovalCountForRisk } from "@/lib/governance/guardrails";
import { requireOrgContext } from "@/lib/org/context";
import { postApprovalRequestToSlack } from "@/lib/slack/approvals";
import { createClient } from "@/lib/supabase/server";

function normalizeWindow(raw: string) {
  return raw === "24h" || raw === "30d" ? raw : "7d";
}

function parseWindowFromFormData(formData: FormData) {
  return normalizeWindow(String(formData.get("window") ?? "").trim());
}

function approvalsBasePathByWindow(window: string) {
  if (window !== "7d") {
    return `/app/approvals?window=${window}`;
  }
  return "/app/approvals";
}

function resolveApprovalsReturnTo(formData: FormData) {
  const window = parseWindowFromFormData(formData);
  const fallback = approvalsBasePathByWindow(window);
  return resolveSafeAppReturnTo(String(formData.get("return_to") ?? "").trim(), fallback);
}

function errorRedirect(message: string, returnTo: string) {
  return withMessageOnReturnTo({ returnTo, kind: "error", message });
}

function okRedirect(message: string, returnTo: string) {
  return withMessageOnReturnTo({ returnTo, kind: "ok", message });
}

function parseObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseDraftRisksFromModelPayload(payload: unknown) {
  const obj = parseObject(payload);
  const output = parseObject(obj?.output);
  if (!output || !Array.isArray(output.risks)) return [];
  return output.risks.filter((item): item is string => typeof item === "string");
}

export async function decideApproval(formData: FormData) {
  const returnTo = resolveApprovalsReturnTo(formData);
  const approvalId = String(formData.get("approval_id") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!approvalId || (decision !== "approved" && decision !== "rejected")) {
    redirect(errorRedirect("承認判断リクエストが不正です。", returnTo));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  let result;
  try {
    result = await decideApprovalShared({
      supabase,
      approvalId,
      decision,
      reason,
      actorType: "user",
      actorId: userId,
      source: "web",
      expectedOrgId: orgId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "承認判断に失敗しました。";
    redirect(errorRedirect(message, returnTo));
  }

  revalidatePath("/app/approvals");
  revalidatePath("/app/tasks");
  revalidatePath(`/app/tasks/${result.taskId}`);
  if (decision === "approved" && result.taskStatus === "ready_for_approval") {
    redirect(okRedirect("一次承認を記録しました。高リスクのため追加承認待ちです。", returnTo));
  }
  redirect(okRedirect(decision === "approved" ? "承認しました。" : "却下しました。", returnTo));
}

export async function resendApprovalSlackReminder(formData: FormData) {
  const returnTo = resolveApprovalsReturnTo(formData);
  const approvalId = String(formData.get("approval_id") ?? "").trim();
  if (!approvalId) {
    redirect(errorRedirect("approval_id がありません。", returnTo));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const slackCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!slackCfg.botToken || !slackCfg.approvalChannelId || !slackCfg.signingSecret) {
    redirect(errorRedirect("Slack承認通知の設定がありません。", returnTo));
  }

  const { data: approval, error: approvalError } = await supabase
    .from("approvals")
    .select("id, task_id, status")
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (approvalError) {
    redirect(errorRedirect(`承認情報の取得に失敗しました: ${approvalError.message}`, returnTo));
  }
  if (!approval || approval.status !== "pending") {
    redirect(errorRedirect("pending 承認のみ再通知できます。", returnTo));
  }

  const taskId = approval.task_id as string;
  try {
    await resendApprovalSlackReminderShared({
      supabase,
      orgId,
      taskId,
      approvalId,
      actorId: userId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slack再通知に失敗しました。";
    redirect(errorRedirect(message, returnTo));
  }

  revalidatePath("/app/approvals");
  revalidatePath(`/app/tasks/${taskId}`);
  redirect(okRedirect("Slackへ承認リマインドを送信しました。", returnTo));
}

async function resendApprovalSlackReminderShared(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  taskId: string;
  approvalId: string;
  actorId: string | null;
}) {
  const { supabase, orgId, taskId, approvalId, actorId } = args;
  const [{ data: task, error: taskError }, { data: latestModel }, { data: latestPolicy }] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title")
      .eq("id", taskId)
      .eq("org_id", orgId)
      .single(),
    supabase
      .from("task_events")
      .select("payload_json")
      .eq("org_id", orgId)
      .eq("task_id", taskId)
      .eq("event_type", "MODEL_INFERRED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("task_events")
      .select("payload_json")
      .eq("org_id", orgId)
      .eq("task_id", taskId)
      .eq("event_type", "POLICY_CHECKED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  if (taskError) {
    throw new Error(`タスク情報の取得に失敗しました: ${taskError.message}`);
  }

  const modelPayload = latestModel?.payload_json as { output?: { summary?: string } } | null;
  const policyPayload = latestPolicy?.payload_json as { status?: string } | null;
  const draftSummary = typeof modelPayload?.output?.summary === "string" ? modelPayload.output.summary : null;
  const policyStatus = typeof policyPayload?.status === "string" ? policyPayload.status : null;

  const slackMessage = await postApprovalRequestToSlack({
    supabase,
    orgId,
    approvalId,
    taskId,
    taskTitle: task.title as string,
    draftSummary,
    policyStatus
  });
  if (slackMessage) {
    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorType: "user",
      actorId,
      eventType: "SLACK_APPROVAL_POSTED",
      payload: {
        channel_id: slackMessage.channel,
        slack_ts: slackMessage.ts,
        reminder: true,
        approval_id: approvalId
      }
    });
  }
}

export async function resendSelectedApprovalSlackReminders(formData: FormData) {
  const returnTo = resolveApprovalsReturnTo(formData);
  const approvalIds = formData
    .getAll("approval_ids")
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (approvalIds.length === 0) {
    redirect(errorRedirect("再通知対象の承認が選択されていません。", returnTo));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const slackCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!slackCfg.botToken || !slackCfg.approvalChannelId || !slackCfg.signingSecret) {
    redirect(errorRedirect("Slack承認通知の設定がありません。", returnTo));
  }

  const { data: approvals, error: approvalsError } = await supabase
    .from("approvals")
    .select("id, task_id, status")
    .eq("org_id", orgId)
    .in("id", approvalIds)
    .eq("status", "pending");
  if (approvalsError) {
    redirect(errorRedirect(`承認情報の取得に失敗しました: ${approvalsError.message}`, returnTo));
  }

  const pendingRows = (approvals ?? []) as Array<{ id: string; task_id: string; status: string }>;
  if (pendingRows.length === 0) {
    redirect(errorRedirect("pending 承認が見つかりません。", returnTo));
  }

  let sentCount = 0;
  for (const row of pendingRows) {
    try {
      await resendApprovalSlackReminderShared({
        supabase,
        orgId,
        taskId: row.task_id,
        approvalId: row.id,
        actorId: userId
      });
      sentCount += 1;
      revalidatePath(`/app/tasks/${row.task_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack再通知に失敗しました。";
      console.error(`[APPROVAL_BULK_REMINDER_FAILED] org_id=${orgId} approval_id=${row.id} ${message}`);
    }
  }

  revalidatePath("/app/approvals");
  if (sentCount === 0) {
    redirect(errorRedirect("Slack再通知を送信できませんでした。ログを確認してください。", returnTo));
  }
  redirect(okRedirect(`Slack再通知を送信しました。sent=${sentCount} target=${pendingRows.length}`, returnTo));
}

export async function sendHighRiskInsufficientRemindersNow(formData: FormData) {
  const returnTo = resolveApprovalsReturnTo(formData);
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const slackCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!slackCfg.botToken || !slackCfg.approvalChannelId || !slackCfg.signingSecret) {
    redirect(errorRedirect("Slack承認通知の設定がありません。", returnTo));
  }

  const { data: pendingApprovals, error: approvalsError } = await supabase
    .from("approvals")
    .select("id, task_id, status")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(500);
  if (approvalsError) {
    redirect(errorRedirect(`pending 承認の取得に失敗しました: ${approvalsError.message}`, returnTo));
  }

  const pendingRows = (pendingApprovals ?? []) as Array<{ id: string; task_id: string; status: string }>;
  if (pendingRows.length === 0) {
    redirect(okRedirect("pending 承認はありません。", returnTo));
  }

  const taskIds = Array.from(new Set(pendingRows.map((row) => row.task_id).filter(Boolean)));
  const [tasksRes, riskRes, policyEventRes, modelEventRes, approvedRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, created_by_user_id")
      .eq("org_id", orgId)
      .in("id", taskIds),
    supabase
      .from("risk_assessments")
      .select("task_id, risk_score, created_at")
      .eq("org_id", orgId)
      .in("task_id", taskIds)
      .order("created_at", { ascending: false })
      .limit(5000),
    supabase
      .from("task_events")
      .select("task_id, payload_json, created_at")
      .eq("org_id", orgId)
      .in("task_id", taskIds)
      .eq("event_type", "POLICY_CHECKED")
      .order("created_at", { ascending: false })
      .limit(5000),
    supabase
      .from("task_events")
      .select("task_id, payload_json, created_at")
      .eq("org_id", orgId)
      .in("task_id", taskIds)
      .eq("event_type", "MODEL_INFERRED")
      .order("created_at", { ascending: false })
      .limit(5000),
    supabase
      .from("approvals")
      .select("task_id, approver_user_id")
      .eq("org_id", orgId)
      .in("task_id", taskIds)
      .eq("status", "approved")
  ]);

  if (tasksRes.error) redirect(errorRedirect(`タスク取得に失敗しました: ${tasksRes.error.message}`, returnTo));
  if (riskRes.error) redirect(errorRedirect(`risk評価取得に失敗しました: ${riskRes.error.message}`, returnTo));
  if (policyEventRes.error) redirect(errorRedirect(`policy取得に失敗しました: ${policyEventRes.error.message}`, returnTo));
  if (modelEventRes.error) redirect(errorRedirect(`モデルイベント取得に失敗しました: ${modelEventRes.error.message}`, returnTo));
  if (approvedRes.error) redirect(errorRedirect(`承認履歴取得に失敗しました: ${approvedRes.error.message}`, returnTo));

  const taskCreatorById = new Map<string, string | null>(
    ((tasksRes.data ?? []) as Array<{ id: string; created_by_user_id: string | null }>).map((row) => [
      row.id,
      row.created_by_user_id
    ])
  );

  const riskScoreByTaskId = new Map<string, number>();
  for (const row of riskRes.data ?? []) {
    const taskId = row.task_id as string;
    if (!taskId || riskScoreByTaskId.has(taskId)) continue;
    const score = Number(row.risk_score ?? NaN);
    if (Number.isFinite(score)) {
      riskScoreByTaskId.set(taskId, Math.max(0, Math.min(100, Math.round(score))));
    }
  }

  const policyByTaskId = new Map<string, "pass" | "warn" | "block">();
  for (const row of policyEventRes.data ?? []) {
    const taskId = row.task_id as string;
    if (!taskId || policyByTaskId.has(taskId)) continue;
    const payload = parseObject(row.payload_json);
    const status = payload?.status;
    if (status === "pass" || status === "warn" || status === "block") {
      policyByTaskId.set(taskId, status);
    }
  }

  const draftRiskCountByTaskId = new Map<string, number>();
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

  const targetRows = pendingRows.filter((row) => {
    const taskId = row.task_id;
    const policy = policyByTaskId.get(taskId) ?? "pass";
    const draftRiskCount = draftRiskCountByTaskId.get(taskId) ?? 0;
    const riskScore =
      riskScoreByTaskId.get(taskId) ??
      Math.min(
        100,
        20 + (policy === "block" ? 50 : policy === "warn" ? 15 : 0) + Math.min(20, draftRiskCount * 5)
      );
    const requiredApprovals = getRequiredApprovalCountForRisk(riskScore);
    const approvedDistinctCount = approversByTaskId.get(taskId)?.size ?? 0;
    return requiredApprovals > 0 && approvedDistinctCount < requiredApprovals;
  });

  if (targetRows.length === 0) {
    redirect(okRedirect("高リスク承認不足の再通知対象はありません。", returnTo));
  }

  let sentCount = 0;
  for (const row of targetRows) {
    try {
      await resendApprovalSlackReminderShared({
        supabase,
        orgId,
        taskId: row.task_id,
        approvalId: row.id,
        actorId: userId
      });
      sentCount += 1;
      revalidatePath(`/app/tasks/${row.task_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack再通知に失敗しました。";
      console.error(`[APPROVAL_HIGH_RISK_REMINDER_FAILED] org_id=${orgId} approval_id=${row.id} ${message}`);
    }
  }

  revalidatePath("/app/approvals");
  if (sentCount === 0) {
    redirect(errorRedirect("高リスク承認不足への再通知送信に失敗しました。", returnTo));
  }
  redirect(okRedirect(`高リスク承認不足へ再通知しました。sent=${sentCount} target=${targetRows.length}`, returnTo));
}

export async function sendStaleApprovalRemindersNow(formData: FormData) {
  const returnTo = resolveApprovalsReturnTo(formData);
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  let result;
  try {
    result = await sendApprovalReminders({
      supabase,
      orgId,
      actorUserId: userId,
      source: "manual"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "承認リマインド送信に失敗しました。";
    redirect(errorRedirect(message, returnTo));
  }

  revalidatePath("/app/approvals");
  if (result.sentCount > 0) {
    redirect(
      okRedirect(
        `SLA超過承認にリマインドを送信しました。sent=${result.sentCount} skippedCooldown=${result.skippedCooldownCount}`,
        returnTo
      )
    );
  }
  redirect(okRedirect(`送信対象なし（reason=${result.reason} target=${result.targetCount}）`, returnTo));
}

function parseOneOffMinStale(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return Math.max(1, Math.min(1000, parsed));
}

export async function runGuardedAutoReminderNow(formData: FormData) {
  const returnTo = resolveApprovalsReturnTo(formData);
  const minStaleRaw = String(formData.get("min_stale") ?? "").trim();
  const oneOffThreshold = parseOneOffMinStale(minStaleRaw);
  if (!oneOffThreshold) {
    redirect(errorRedirect("min_stale が不正です。", returnTo));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const staleHours = Number(process.env.APPROVAL_REMINDER_STALE_HOURS ?? process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6");
  const staleCutoffIso = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();

  const countRes = await supabase
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "pending")
    .lt("created_at", staleCutoffIso);
  if (countRes.error) {
    redirect(errorRedirect(`stale件数の取得に失敗しました: ${countRes.error.message}`, returnTo));
  }
  const stalePendingCount = countRes.count ?? 0;
  if (stalePendingCount < oneOffThreshold) {
    revalidatePath("/app/approvals");
    redirect(okRedirect(`guardによりスキップ: stale=${stalePendingCount} threshold=${oneOffThreshold}`, returnTo));
  }

  let result;
  try {
    result = await sendApprovalReminders({
      supabase,
      orgId,
      actorUserId: userId,
      source: "manual"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ガード付き再通知に失敗しました。";
    redirect(errorRedirect(message, returnTo));
  }

  revalidatePath("/app/approvals");
  if (result.sentCount > 0) {
    redirect(okRedirect(`guard実行: stale=${stalePendingCount} threshold=${oneOffThreshold} sent=${result.sentCount}`, returnTo));
  }
  redirect(okRedirect(`guard実行: stale=${stalePendingCount} threshold=${oneOffThreshold} reason=${result.reason}`, returnTo));
}
