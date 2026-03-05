import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { postApprovalRequestToSlack } from "@/lib/slack/approvals";

export type ApprovalReminderResult = {
  sent: boolean;
  reason: "sent" | "no_stale_pending" | "slack_not_configured" | "cooldown_skipped";
  targetCount: number;
  sentCount: number;
  skippedCooldownCount: number;
};

function getReminderConfig() {
  const staleHoursRaw = Number.parseInt(process.env.APPROVAL_REMINDER_STALE_HOURS ?? "", 10);
  const fallbackStaleRaw = Number.parseInt(process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6", 10);
  const staleHours = Number.isNaN(staleHoursRaw)
    ? Number.isNaN(fallbackStaleRaw)
      ? 6
      : fallbackStaleRaw
    : staleHoursRaw;

  const cooldownRaw = Number.parseInt(process.env.APPROVAL_REMINDER_COOLDOWN_MINUTES ?? "120", 10);
  const cooldownMinutes = Number.isNaN(cooldownRaw) ? 120 : Math.max(5, Math.min(24 * 60, cooldownRaw));
  const maxTargetsRaw = Number.parseInt(process.env.APPROVAL_REMINDER_MAX_TARGETS ?? "20", 10);
  const maxTargets = Number.isNaN(maxTargetsRaw) ? 20 : Math.max(1, Math.min(200, maxTargetsRaw));
  return {
    staleHours: Math.max(1, Math.min(24 * 14, staleHours)),
    cooldownMinutes,
    maxTargets
  };
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export async function sendApprovalReminders(args: {
  supabase: SupabaseClient;
  orgId: string;
  actorUserId?: string | null;
  source?: "cron" | "manual";
}): Promise<ApprovalReminderResult> {
  const { supabase, orgId, actorUserId = null, source = "cron" } = args;
  const cfg = getReminderConfig();
  const staleCutoffIso = new Date(Date.now() - cfg.staleHours * 60 * 60 * 1000).toISOString();
  const cooldownCutoffIso = new Date(Date.now() - cfg.cooldownMinutes * 60 * 1000).toISOString();

  const slackCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!slackCfg.botToken || !slackCfg.approvalChannelId || !slackCfg.signingSecret) {
    return {
      sent: false,
      reason: "slack_not_configured",
      targetCount: 0,
      sentCount: 0,
      skippedCooldownCount: 0
    };
  }

  const { data: approvals, error: approvalsError } = await supabase
    .from("approvals")
    .select("id, task_id, status, created_at")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .lt("created_at", staleCutoffIso)
    .order("created_at", { ascending: true })
    .limit(cfg.maxTargets);
  if (approvalsError) {
    throw new Error(`approval reminder query failed: ${approvalsError.message}`);
  }

  const pendingRows = approvals ?? [];
  if (pendingRows.length === 0) {
    return {
      sent: false,
      reason: "no_stale_pending",
      targetCount: 0,
      sentCount: 0,
      skippedCooldownCount: 0
    };
  }

  const taskIds = pendingRows.map((row) => row.task_id as string);

  const [{ data: recentReminderEvents, error: recentError }, { data: tasks, error: tasksError }] = await Promise.all([
    supabase
      .from("task_events")
      .select("task_id, payload_json, created_at")
      .eq("org_id", orgId)
      .eq("event_type", "SLACK_APPROVAL_POSTED")
      .gte("created_at", cooldownCutoffIso)
      .in("task_id", taskIds)
      .order("created_at", { ascending: false })
      .limit(300),
    supabase.from("tasks").select("id, title").eq("org_id", orgId).in("id", taskIds)
  ]);

  if (recentError && !isMissingTableError(recentError.message, "task_events")) {
    throw new Error(`approval reminder dedupe query failed: ${recentError.message}`);
  }
  if (tasksError) {
    throw new Error(`approval reminder task lookup failed: ${tasksError.message}`);
  }

  const titleByTaskId = new Map<string, string>((tasks ?? []).map((row) => [row.id as string, row.title as string]));

  const recentlyRemindedApprovalIds = new Set<string>();
  for (const row of recentReminderEvents ?? []) {
    const payload =
      typeof row.payload_json === "object" && row.payload_json !== null
        ? (row.payload_json as Record<string, unknown>)
        : null;
    const approvalId = typeof payload?.approval_id === "string" ? payload.approval_id : null;
    if (approvalId) {
      recentlyRemindedApprovalIds.add(approvalId);
    }
  }

  let sentCount = 0;
  let skippedCooldownCount = 0;

  for (const approval of pendingRows) {
    const approvalId = approval.id as string;
    const taskId = approval.task_id as string;

    if (recentlyRemindedApprovalIds.has(approvalId)) {
      skippedCooldownCount += 1;
      continue;
    }

    const [{ data: latestModel }, { data: latestPolicy }] = await Promise.all([
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

    const modelPayload = latestModel?.payload_json as { output?: { summary?: string } } | null;
    const policyPayload = latestPolicy?.payload_json as { status?: string } | null;
    const draftSummary =
      typeof modelPayload?.output?.summary === "string" ? modelPayload.output.summary : null;
    const policyStatus = typeof policyPayload?.status === "string" ? policyPayload.status : null;

    try {
      const slackMessage = await postApprovalRequestToSlack({
        supabase,
        orgId,
        approvalId,
        taskId,
        taskTitle: titleByTaskId.get(taskId) ?? taskId,
        draftSummary,
        policyStatus
      });
      if (slackMessage) {
        sentCount += 1;
        await appendTaskEvent({
          supabase,
          orgId,
          taskId,
          actorType: "system",
          actorId: actorUserId,
          eventType: "SLACK_APPROVAL_POSTED",
          payload: {
            channel_id: slackMessage.channel,
            slack_ts: slackMessage.ts,
            reminder: true,
            source,
            approval_id: approvalId
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "approval reminder failed";
      console.error(`[APPROVAL_REMINDER_POST_FAILED] org_id=${orgId} approval_id=${approvalId} ${message}`);
    }
  }

  return {
    sent: sentCount > 0,
    reason: sentCount > 0 ? "sent" : skippedCooldownCount > 0 ? "cooldown_skipped" : "no_stale_pending",
    targetCount: pendingRows.length,
    sentCount,
    skippedCooldownCount
  };
}
