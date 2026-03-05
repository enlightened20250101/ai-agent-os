import type { SupabaseClient } from "@supabase/supabase-js";
import { getConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { getOrCreateGovernanceOpsTaskId } from "@/lib/governance/review";
import { postSlackMessage } from "@/lib/slack/client";

type OpsHealth = {
  plannerConsecutiveFailures: number;
  reviewConsecutiveFailures: number;
  latestPlannerFailedAt: string | null;
  latestReviewFailedAt: string | null;
};

function threshold() {
  const raw = Number.parseInt(process.env.OPS_ALERT_CONSECUTIVE_FAIL_THRESHOLD ?? "2", 10);
  if (Number.isNaN(raw)) return 2;
  return Math.max(1, Math.min(10, raw));
}

function bucket30m() {
  const now = Date.now();
  const bucketMs = 30 * 60 * 1000;
  return Math.floor(now / bucketMs);
}

async function resolveOpsSlackTarget(args: { supabase: SupabaseClient; orgId: string }) {
  const { supabase, orgId } = args;
  const connector = await getConnectorAccount({ supabase, orgId, provider: "slack" });
  const dbAlertChannel =
    connector && typeof connector.secrets_json.alert_channel_id === "string"
      ? connector.secrets_json.alert_channel_id
      : "";
  const envAlertChannel = process.env.SLACK_ALERTS_CHANNEL_ID ?? "";
  const runtimeCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  const alertChannel = dbAlertChannel || envAlertChannel || runtimeCfg.approvalChannelId;
  return {
    runtimeCfg,
    alertChannel
  };
}

async function loadOpsHealth(args: { supabase: SupabaseClient; orgId: string }): Promise<OpsHealth> {
  const { supabase, orgId } = args;
  const [plannerRunsRes, reviewEventsRes] = await Promise.all([
    supabase
      .from("planner_runs")
      .select("status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("task_events")
      .select("event_type, created_at")
      .eq("org_id", orgId)
      .in("event_type", ["GOVERNANCE_RECOMMENDATIONS_REVIEWED", "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"])
      .order("created_at", { ascending: false })
      .limit(20)
  ]);
  if (plannerRunsRes.error) {
    throw new Error(`planner run health query failed: ${plannerRunsRes.error.message}`);
  }
  if (reviewEventsRes.error) {
    throw new Error(`review event health query failed: ${reviewEventsRes.error.message}`);
  }
  const plannerRuns = plannerRunsRes.data ?? [];
  const reviewEvents = reviewEventsRes.data ?? [];

  let plannerConsecutiveFailures = 0;
  for (const row of plannerRuns) {
    if (row.status === "failed") plannerConsecutiveFailures += 1;
    else break;
  }
  let reviewConsecutiveFailures = 0;
  for (const row of reviewEvents) {
    if (row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED") reviewConsecutiveFailures += 1;
    else break;
  }

  const latestPlannerFailedAt =
    ((plannerRuns.find((row) => row.status === "failed")?.created_at as string | undefined) ?? null);
  const latestReviewFailedAt =
    ((reviewEvents.find((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED")?.created_at as
      | string
      | undefined) ?? null);

  return {
    plannerConsecutiveFailures,
    reviewConsecutiveFailures,
    latestPlannerFailedAt,
    latestReviewFailedAt
  };
}

export async function maybeSendOpsFailureAlert(args: {
  supabase: SupabaseClient;
  orgId: string;
  force?: boolean;
  source?: "auto" | "manual";
}) {
  const { supabase, orgId, force = false, source = "auto" } = args;
  if (process.env.ENABLE_OPS_SLACK_ALERTS !== "1") {
    return { sent: false, reason: "alerts_disabled" as const, alertKey: null as string | null };
  }

  const health = await loadOpsHealth({ supabase, orgId });
  const failThreshold = threshold();
  const breached =
    health.plannerConsecutiveFailures >= failThreshold || health.reviewConsecutiveFailures >= failThreshold;
  if (!breached && !force) {
    return { sent: false, reason: "threshold_not_met" as const, alertKey: null as string | null, health };
  }

  const { runtimeCfg, alertChannel } = await resolveOpsSlackTarget({ supabase, orgId });
  if (!runtimeCfg.botToken || !alertChannel) {
    return { sent: false, reason: "slack_not_configured" as const, alertKey: null as string | null, health };
  }

  const alertKey = `ops_failures:${orgId}:${source}:${bucket30m()}:${health.plannerConsecutiveFailures}:${health.reviewConsecutiveFailures}`;
  const { data: existingAlert, error: existingAlertError } = await supabase
    .from("task_events")
    .select("id")
    .eq("org_id", orgId)
    .eq("event_type", "OPS_ALERT_POSTED")
    .filter("payload_json->>alert_key", "eq", alertKey)
    .limit(1)
    .maybeSingle();
  if (existingAlertError) {
    throw new Error(`ops alert dedupe query failed: ${existingAlertError.message}`);
  }
  if (existingAlert?.id && !force) {
    return { sent: false, reason: "deduped" as const, alertKey, health };
  }

  const taskId = await getOrCreateGovernanceOpsTaskId({ supabase, orgId });
  try {
    const msg = await postSlackMessage({
      botToken: runtimeCfg.botToken,
      channel: alertChannel,
      text: `AI Agent OS Ops Alert: planner/review failures exceeded threshold`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*AI Agent OS Ops Alert*\n連続失敗がしきい値を超過しました。"
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `org_id: ${orgId}\n` +
              `planner consecutive failures: ${health.plannerConsecutiveFailures}\n` +
              `review consecutive failures: ${health.reviewConsecutiveFailures}\n` +
              `planner latest failed: ${health.latestPlannerFailedAt ?? "none"}\n` +
              `review latest failed: ${health.latestReviewFailedAt ?? "none"}`
          }
        }
      ]
    });

    const { error: logOkError } = await supabase.from("task_events").insert({
      org_id: orgId,
      task_id: taskId,
      actor_type: "system",
      actor_id: null,
      event_type: "OPS_ALERT_POSTED",
      payload_json: {
        alert_key: alertKey,
        threshold: failThreshold,
        source,
        forced: force,
        health,
        channel_id: msg.channel,
        slack_ts: msg.ts,
        slack_permalink: msg.permalink ?? null
      }
    });
    if (logOkError) {
      throw new Error(`ops alert log insert failed: ${logOkError.message}`);
    }

    return { sent: true, reason: "posted" as const, alertKey, health };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown ops alert error";
    await supabase.from("task_events").insert({
      org_id: orgId,
      task_id: taskId,
      actor_type: "system",
      actor_id: null,
      event_type: "OPS_ALERT_FAILED",
      payload_json: {
        alert_key: alertKey,
        threshold: failThreshold,
        source,
        forced: force,
        health,
        error: message
      }
    });
    return { sent: false, reason: "post_failed" as const, alertKey, health, error: message };
  }
}

export async function maybeSendJobCircuitAlert(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
  pausedUntil: string | null;
  consecutiveFailures: number;
}) {
  const { supabase, orgId, jobName, pausedUntil, consecutiveFailures } = args;
  if (process.env.ENABLE_OPS_SLACK_ALERTS !== "1") {
    return { sent: false, reason: "alerts_disabled" as const, alertKey: null as string | null };
  }

  const { runtimeCfg, alertChannel } = await resolveOpsSlackTarget({ supabase, orgId });
  if (!runtimeCfg.botToken || !alertChannel) {
    return { sent: false, reason: "slack_not_configured" as const, alertKey: null as string | null };
  }

  const alertKey = `job_circuit:${orgId}:${jobName}:${bucket30m()}:${pausedUntil ?? "none"}`;
  const { data: existingAlert, error: existingAlertError } = await supabase
    .from("task_events")
    .select("id")
    .eq("org_id", orgId)
    .eq("event_type", "OPS_JOB_CIRCUIT_ALERT_POSTED")
    .filter("payload_json->>alert_key", "eq", alertKey)
    .limit(1)
    .maybeSingle();
  if (existingAlertError) {
    throw new Error(`job circuit alert dedupe query failed: ${existingAlertError.message}`);
  }
  if (existingAlert?.id) {
    return { sent: false, reason: "deduped" as const, alertKey };
  }

  const taskId = await getOrCreateGovernanceOpsTaskId({ supabase, orgId });
  try {
    const msg = await postSlackMessage({
      botToken: runtimeCfg.botToken,
      channel: alertChannel,
      text: `AI Agent OS Ops Alert: job circuit opened (${jobName})`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*AI Agent OS Circuit Alert*\nジョブサーキットが開放されました。"
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `org_id: ${orgId}\n` +
              `job_name: ${jobName}\n` +
              `consecutive_failures: ${consecutiveFailures}\n` +
              `paused_until: ${pausedUntil ?? "-"}`
          }
        }
      ]
    });

    const { error: logOkError } = await supabase.from("task_events").insert({
      org_id: orgId,
      task_id: taskId,
      actor_type: "system",
      actor_id: null,
      event_type: "OPS_JOB_CIRCUIT_ALERT_POSTED",
      payload_json: {
        alert_key: alertKey,
        job_name: jobName,
        consecutive_failures: consecutiveFailures,
        paused_until: pausedUntil,
        channel_id: msg.channel,
        slack_ts: msg.ts,
        slack_permalink: msg.permalink ?? null
      }
    });
    if (logOkError) {
      throw new Error(`job circuit alert log insert failed: ${logOkError.message}`);
    }
    return { sent: true, reason: "posted" as const, alertKey };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown job circuit alert error";
    await supabase.from("task_events").insert({
      org_id: orgId,
      task_id: taskId,
      actor_type: "system",
      actor_id: null,
      event_type: "OPS_JOB_CIRCUIT_ALERT_FAILED",
      payload_json: {
        alert_key: alertKey,
        job_name: jobName,
        consecutive_failures: consecutiveFailures,
        paused_until: pausedUntil,
        error: message
      }
    });
    return { sent: false, reason: "post_failed" as const, alertKey, error: message };
  }
}
