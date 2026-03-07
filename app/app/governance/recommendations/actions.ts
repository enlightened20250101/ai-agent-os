"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendTaskEvent, getOrCreateAgentOpsTaskId } from "@/lib/events/taskEvents";
import { getGovernanceSettings } from "@/lib/governance/evaluate";
import { buildGovernanceRecommendations, type GovernanceRecommendationSummary } from "@/lib/governance/recommendations";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { postSlackMessage } from "@/lib/slack/client";
import { runGovernanceRecommendationReview } from "@/lib/governance/review";

function normalizeWindow(windowValue: string) {
  if (windowValue === "24h" || windowValue === "30d") return windowValue;
  return "7d";
}

function withMessage(kind: "ok" | "error", message: string, windowValue: string) {
  const params = new URLSearchParams();
  params.set(kind, message);
  params.set("window", normalizeWindow(windowValue));
  return `/app/governance/recommendations?${params.toString()}`;
}

function withRetryMessage(message: string, actionKind: string, recommendationId: string, windowValue: string) {
  const params = new URLSearchParams();
  params.set("error", message);
  params.set("retry_action_kind", actionKind);
  params.set("retry_recommendation_id", recommendationId);
  params.set("window", normalizeWindow(windowValue));
  return `/app/governance/recommendations?${params.toString()}`;
}

function recommendationNotFoundError(windowValue: string) {
  return withMessage("error", "指定した改善提案が見つかりません。再評価してから再実行してください。", windowValue);
}

function windowHoursFromValue(windowValue: string) {
  if (windowValue === "24h") return 24;
  if (windowValue === "30d") return 24 * 30;
  return 24 * 7;
}

function isMissingGovernanceTable(message: string) {
  return (
    message.includes('relation "org_autonomy_settings" does not exist') ||
    message.includes("Could not find the table 'public.org_autonomy_settings'")
  );
}

async function disableAutoExecute(args: {
  orgId: string;
  userId: string;
  recommendationId: string;
  baseline: GovernanceRecommendationSummary;
}) {
  const { orgId, userId, recommendationId, baseline } = args;
  const supabase = await createClient();
  const settings = await getGovernanceSettings({ supabase, orgId });

  const { error } = await supabase.from("org_autonomy_settings").upsert(
    {
      org_id: orgId,
      autonomy_level: settings.autonomyLevel,
      auto_execute_google_send_email: false,
      max_auto_execute_risk_score: settings.maxAutoExecuteRiskScore,
      min_trust_score: settings.minTrustScore,
      daily_send_email_limit: settings.dailySendEmailLimit
    },
    { onConflict: "org_id" }
  );

  if (error) {
    if (isMissingGovernanceTable(error.message)) {
      throw new Error("governance migration が未適用です。Supabase migration を実行してください。");
    }
    throw new Error(error.message);
  }

  const systemTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: systemTaskId,
    actorType: "user",
    actorId: userId,
    eventType: "GOVERNANCE_RECOMMENDATION_APPLIED",
    payload: {
      recommendation_id: recommendationId,
      action_kind: "disable_auto_execute",
      result: "success",
      baseline_summary: baseline,
      followup_href: "/app/governance/autonomy",
      updated_fields: { auto_execute_google_send_email: false }
    }
  });
}

async function sendApprovalReminder(args: {
  orgId: string;
  userId: string;
  recommendationId: string;
  baseline: GovernanceRecommendationSummary;
}) {
  const { orgId, userId, recommendationId, baseline } = args;
  const supabase = await createClient();
  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: staleApprovals, error: approvalsError } = await supabase
    .from("approvals")
    .select("id, task_id, created_at")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(10);

  if (approvalsError) {
    throw new Error(approvalsError.message);
  }
  if (!staleApprovals || staleApprovals.length === 0) {
    return { reminderCount: 0 };
  }

  const taskIds = staleApprovals.map((row) => row.task_id);
  const { data: tasks, error: taskError } = await supabase
    .from("tasks")
    .select("id, title")
    .eq("org_id", orgId)
    .in("id", taskIds);
  if (taskError) {
    throw new Error(taskError.message);
  }

  const taskTitleById = new Map<string, string>();
  for (const task of tasks ?? []) {
    taskTitleById.set(task.id as string, (task.title as string) ?? "untitled");
  }

  const cfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!cfg.botToken || !cfg.approvalChannelId) {
    throw new Error("Slack連携が未設定です（DB または env fallback）。");
  }

  try {
    await postSlackMessage({
      botToken: cfg.botToken,
      channel: cfg.approvalChannelId,
      text: `承認滞留リマインド: ${staleApprovals.length}件`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*承認滞留リマインド*\n24時間超の pending approval が *${staleApprovals.length}件* あります。`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: staleApprovals
              .map((row, idx) => {
                const taskId = row.task_id as string;
                const title = taskTitleById.get(taskId) ?? taskId;
                const createdAt = new Date(row.created_at as string).toLocaleString();
                return `${idx + 1}. ${title} (${createdAt})`;
              })
              .join("\n")
          }
        }
      ]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slack送信に失敗しました。";
    throw new Error(message);
  }

  const systemTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: systemTaskId,
    actorType: "user",
    actorId: userId,
    eventType: "GOVERNANCE_RECOMMENDATION_APPLIED",
    payload: {
      recommendation_id: recommendationId,
      action_kind: "send_approval_reminder",
      result: "success",
      baseline_summary: baseline,
      followup_href: "/app/approvals",
      reminder_count: staleApprovals.length
    }
  });

  return { reminderCount: staleApprovals.length };
}

export async function applyRecommendationAction(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const windowValue = normalizeWindow(String(formData.get("window") ?? "").trim());
  const { summary: baseline } = await buildGovernanceRecommendations({
    supabase,
    orgId,
    windowHours: windowHoursFromValue(windowValue)
  });

  const recommendationId = String(formData.get("recommendation_id") ?? "").trim();
  const actionKind = String(formData.get("action_kind") ?? "").trim();
  const confirmRisky = String(formData.get("confirm_risky") ?? "").trim();
  if (!recommendationId || !actionKind) {
    redirect(withMessage("error", "recommendation_id/action_kind が不足しています。", windowValue));
  }

  if (actionKind === "disable_auto_execute") {
    if (confirmRisky !== "yes") {
      redirect(withRetryMessage("危険操作を実行するには確認チェックが必要です。", actionKind, recommendationId, windowValue));
    }
    try {
      await disableAutoExecute({ orgId, userId, recommendationId, baseline });
    } catch (error) {
      const systemTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
      await appendTaskEvent({
        supabase,
        orgId,
        taskId: systemTaskId,
        actorType: "user",
        actorId: userId,
        eventType: "GOVERNANCE_RECOMMENDATION_FAILED",
        payload: {
          recommendation_id: recommendationId,
          action_kind: actionKind,
          result: "failed",
          baseline_summary: baseline,
          error: error instanceof Error ? error.message : "unknown error"
        }
      });
      const message = error instanceof Error ? error.message : "改善提案アクションに失敗しました。";
      redirect(withRetryMessage(message, actionKind, recommendationId, windowValue));
    }
    revalidatePath("/app/governance/autonomy");
    revalidatePath("/app/tasks");
    revalidatePath("/app");
    revalidatePath("/app/governance/recommendations");
    redirect(withMessage("ok", "自動実行を一時停止しました。", windowValue));
  }

  if (actionKind === "send_approval_reminder") {
    let result: { reminderCount: number } | null = null;
    try {
      result = await sendApprovalReminder({ orgId, userId, recommendationId, baseline });
    } catch (error) {
      const systemTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
      await appendTaskEvent({
        supabase,
        orgId,
        taskId: systemTaskId,
        actorType: "user",
        actorId: userId,
        eventType: "GOVERNANCE_RECOMMENDATION_FAILED",
        payload: {
          recommendation_id: recommendationId,
          action_kind: actionKind,
          result: "failed",
          baseline_summary: baseline,
          error: error instanceof Error ? error.message : "unknown error"
        }
      });
      const message = error instanceof Error ? error.message : "改善提案アクションに失敗しました。";
      redirect(withRetryMessage(message, actionKind, recommendationId, windowValue));
    }
    revalidatePath("/app/approvals");
    revalidatePath("/app/governance/recommendations");
    if (!result || result.reminderCount === 0) {
      redirect(withMessage("ok", "催促対象の承認はありませんでした。", windowValue));
    }
    redirect(withMessage("ok", "Slackに承認催促メッセージを送信しました。", windowValue));
  }

  redirect(withMessage("error", `未対応の action_kind です: ${actionKind}`, windowValue));
}

export async function acknowledgeRecommendation(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const windowValue = normalizeWindow(String(formData.get("window") ?? "").trim());
  const recommendationId = String(formData.get("recommendation_id") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const ownerUserIdRaw = String(formData.get("owner_user_id") ?? "").trim();
  const dueDaysRaw = Number.parseInt(String(formData.get("due_days") ?? "").trim(), 10);
  const dueDays = Number.isFinite(dueDaysRaw) ? Math.max(1, Math.min(90, dueDaysRaw)) : 7;
  const dueAtIso = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString();
  const ownerUserId = ownerUserIdRaw || userId;

  if (!recommendationId) {
    redirect(withMessage("error", "recommendation_id が不足しています。", windowValue));
  }

  const { summary: baseline, recommendations } = await buildGovernanceRecommendations({
    supabase,
    orgId,
    windowHours: windowHoursFromValue(windowValue)
  });
  const matched = recommendations.find((item) => item.id === recommendationId);
  if (!matched) {
    redirect(recommendationNotFoundError(windowValue));
  }

  const systemTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: systemTaskId,
    actorType: "user",
    actorId: userId,
    eventType: "GOVERNANCE_RECOMMENDATION_APPLIED",
    payload: {
      recommendation_id: recommendationId,
      recommendation_title: matched.title,
      action_kind: "acknowledge_recommendation",
      result: "success",
      baseline_summary: baseline,
      followup_href: matched.href,
      note: note || null,
      ack_meta: {
        owner_user_id: ownerUserId,
        due_at: dueAtIso,
        due_days: dueDays
      }
    }
  });

  revalidatePath("/app/governance/recommendations");
  revalidatePath("/app");
  redirect(withMessage("ok", "改善提案を対処済みとして記録しました。", windowValue));
}

export async function runRecommendationsReviewNow(formData: FormData) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const windowValue = normalizeWindow(String(formData.get("window") ?? "").trim());

  const result = await runGovernanceRecommendationReview({ supabase, orgId });
  if (!result.ok) {
    redirect(withMessage("error", result.error ?? "改善提案レビュー実行に失敗しました。", windowValue));
  }

  revalidatePath("/app/governance/recommendations");
  redirect(withMessage("ok", "改善提案の再評価を実行しました。", windowValue));
}
