"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sendApprovalReminders } from "@/lib/approvals/reminders";
import { decideApprovalShared } from "@/lib/approvals/decide";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { postApprovalRequestToSlack } from "@/lib/slack/approvals";
import { createClient } from "@/lib/supabase/server";

function errorRedirect(message: string) {
  return `/app/approvals?error=${encodeURIComponent(message)}`;
}

function okRedirect(message: string) {
  return `/app/approvals?ok=${encodeURIComponent(message)}`;
}

export async function decideApproval(formData: FormData) {
  const approvalId = String(formData.get("approval_id") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!approvalId || (decision !== "approved" && decision !== "rejected")) {
    redirect(errorRedirect("承認判断リクエストが不正です。"));
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
    redirect(errorRedirect(message));
  }

  revalidatePath("/app/approvals");
  revalidatePath("/app/tasks");
  revalidatePath(`/app/tasks/${result.taskId}`);
  redirect(okRedirect(decision === "approved" ? "承認しました。" : "却下しました。"));
}

export async function resendApprovalSlackReminder(formData: FormData) {
  const approvalId = String(formData.get("approval_id") ?? "").trim();
  if (!approvalId) {
    redirect(errorRedirect("approval_id がありません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const slackCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!slackCfg.botToken || !slackCfg.approvalChannelId || !slackCfg.signingSecret) {
    redirect(errorRedirect("Slack承認通知の設定がありません。"));
  }

  const { data: approval, error: approvalError } = await supabase
    .from("approvals")
    .select("id, task_id, status")
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (approvalError) {
    redirect(errorRedirect(`承認情報の取得に失敗しました: ${approvalError.message}`));
  }
  if (!approval || approval.status !== "pending") {
    redirect(errorRedirect("pending 承認のみ再通知できます。"));
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
    redirect(errorRedirect(message));
  }

  revalidatePath("/app/approvals");
  revalidatePath(`/app/tasks/${taskId}`);
  redirect(okRedirect("Slackへ承認リマインドを送信しました。"));
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
  const approvalIds = formData
    .getAll("approval_ids")
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (approvalIds.length === 0) {
    redirect(errorRedirect("再通知対象の承認が選択されていません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const slackCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!slackCfg.botToken || !slackCfg.approvalChannelId || !slackCfg.signingSecret) {
    redirect(errorRedirect("Slack承認通知の設定がありません。"));
  }

  const { data: approvals, error: approvalsError } = await supabase
    .from("approvals")
    .select("id, task_id, status")
    .eq("org_id", orgId)
    .in("id", approvalIds)
    .eq("status", "pending");
  if (approvalsError) {
    redirect(errorRedirect(`承認情報の取得に失敗しました: ${approvalsError.message}`));
  }

  const pendingRows = (approvals ?? []) as Array<{ id: string; task_id: string; status: string }>;
  if (pendingRows.length === 0) {
    redirect(errorRedirect("pending 承認が見つかりません。"));
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
    redirect(errorRedirect("Slack再通知を送信できませんでした。ログを確認してください。"));
  }
  redirect(okRedirect(`Slack再通知を送信しました。sent=${sentCount} target=${pendingRows.length}`));
}

export async function sendStaleApprovalRemindersNow() {
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
    redirect(errorRedirect(message));
  }

  revalidatePath("/app/approvals");
  if (result.sentCount > 0) {
    redirect(
      okRedirect(
        `SLA超過承認にリマインドを送信しました。sent=${result.sentCount} skippedCooldown=${result.skippedCooldownCount}`
      )
    );
  }
  redirect(okRedirect(`送信対象なし（reason=${result.reason} target=${result.targetCount}）`));
}
