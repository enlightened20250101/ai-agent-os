import type { SupabaseClient } from "@supabase/supabase-js";
import { appendExceptionCaseEvent } from "@/lib/governance/exceptionCaseEvents";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { postSlackMessage } from "@/lib/slack/client";

type ExceptionCaseRow = {
  id: string;
  kind: "failed_action" | "failed_workflow" | "stale_approval" | "policy_block";
  ref_id: string;
  task_id: string | null;
  status: "open" | "in_progress" | "resolved";
  owner_user_id: string | null;
  note: string;
  due_at: string | null;
  last_alerted_at: string | null;
  updated_at: string;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function getCooldownMinutes() {
  const raw = Number.parseInt(process.env.EXCEPTION_ALERT_COOLDOWN_MINUTES ?? "60", 10);
  if (Number.isNaN(raw)) return 60;
  return Math.max(10, Math.min(24 * 60, raw));
}

function getEscalationThresholdHours() {
  const parse = (name: string, fallback: number) => {
    const raw = Number.parseInt(process.env[name] ?? String(fallback), 10);
    if (Number.isNaN(raw)) return fallback;
    return Math.max(1, Math.min(24 * 14, raw));
  };
  const medium = parse("EXCEPTION_ESCALATION_HOURS_L1", 2);
  const high = Math.max(medium, parse("EXCEPTION_ESCALATION_HOURS_L2", 8));
  const critical = Math.max(high, parse("EXCEPTION_ESCALATION_HOURS_L3", 24));
  return { medium, high, critical };
}

function getOverdueHours(row: ExceptionCaseRow, nowMs: number) {
  if (!row.due_at) return 0;
  const dueMs = new Date(row.due_at).getTime();
  if (!Number.isFinite(dueMs) || dueMs >= nowMs) return 0;
  return Math.floor((nowMs - dueMs) / (60 * 60 * 1000));
}

function getEscalationLevel(args: { row: ExceptionCaseRow; nowMs: number }) {
  const { row, nowMs } = args;
  const overdueHours = getOverdueHours(row, nowMs);
  const { medium, high, critical } = getEscalationThresholdHours();
  if (overdueHours >= critical) return { level: "critical" as const, overdueHours };
  if (overdueHours >= high) return { level: "high" as const, overdueHours };
  if (overdueHours >= medium || !row.owner_user_id) return { level: "medium" as const, overdueHours };
  return { level: "low" as const, overdueHours };
}

async function resolveDefaultAssignee(args: { supabase: SupabaseClient; orgId: string }) {
  const { supabase, orgId } = args;
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id, role, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    throw new Error(`default assignee lookup failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{ user_id: string; role: string; created_at: string }>;
  if (rows.length === 0) return null;
  const owner = rows.find((row) => row.role === "owner");
  if (owner?.user_id) return owner.user_id;
  const admin = rows.find((row) => row.role === "admin");
  if (admin?.user_id) return admin.user_id;
  return rows[0]?.user_id ?? null;
}

function isEligibleForAlert(row: ExceptionCaseRow, nowMs: number, cooldownMs: number) {
  if (row.status === "resolved") return false;
  const dueMs = row.due_at ? new Date(row.due_at).getTime() : null;
  const overdue = dueMs !== null && Number.isFinite(dueMs) && dueMs < nowMs;
  const unassigned = !row.owner_user_id;
  if (!overdue && !unassigned) return false;

  if (row.last_alerted_at) {
    const lastMs = new Date(row.last_alerted_at).getTime();
    if (Number.isFinite(lastMs) && nowMs - lastMs < cooldownMs) {
      return false;
    }
  }
  return true;
}

export async function notifyExceptionCases(args: {
  supabase: SupabaseClient;
  orgId: string;
  source?: "manual" | "cron";
}) {
  const { supabase, orgId, source = "manual" } = args;

  const { data: cases, error: casesError } = await supabase
    .from("exception_cases")
    .select("id, kind, ref_id, task_id, status, owner_user_id, note, due_at, last_alerted_at, updated_at")
    .eq("org_id", orgId)
    .in("status", ["open", "in_progress"])
    .order("updated_at", { ascending: false })
    .limit(200);

  if (casesError) {
    if (isMissingTableError(casesError.message, "exception_cases")) {
      return { sent: false, reason: "exception_cases_missing" as const, targetCount: 0 };
    }
    throw new Error(`exception cases query failed: ${casesError.message}`);
  }

  const rows = (cases ?? []) as ExceptionCaseRow[];
  const nowMs = Date.now();
  const cooldownMs = getCooldownMinutes() * 60 * 1000;
  const targets = rows.filter((row) => isEligibleForAlert(row, nowMs, cooldownMs));
  const targetIds = targets.map((row) => row.id);

  if (targets.length === 0) {
    return { sent: false, reason: "no_targets" as const, targetCount: 0, targetIds };
  }

  const defaultAssignee = await resolveDefaultAssignee({ supabase, orgId });
  const autoAssignedTargets: string[] = [];
  if (defaultAssignee) {
    const unassignedTargetIds = targets.filter((row) => !row.owner_user_id).map((row) => row.id);
    if (unassignedTargetIds.length > 0) {
      const nowIso = new Date().toISOString();
      const { error: assignError } = await supabase
        .from("exception_cases")
        .update({
          owner_user_id: defaultAssignee,
          updated_at: nowIso
        })
        .eq("org_id", orgId)
        .in("id", unassignedTargetIds);
      if (!assignError) {
        for (const row of targets) {
          if (!row.owner_user_id && unassignedTargetIds.includes(row.id)) {
            row.owner_user_id = defaultAssignee;
            autoAssignedTargets.push(row.id);
          }
        }
      }
    }
  }

  const escalationCounts = { low: 0, medium: 0, high: 0, critical: 0 };
  const escalationByCase = new Map<string, { level: "low" | "medium" | "high" | "critical"; overdueHours: number }>();
  for (const row of targets) {
    const escalation = getEscalationLevel({ row, nowMs });
    escalationByCase.set(row.id, escalation);
    escalationCounts[escalation.level] += 1;
  }

  for (const row of targets) {
    if (autoAssignedTargets.includes(row.id)) {
      await appendExceptionCaseEvent({
        supabase,
        orgId,
        exceptionCaseId: row.id,
        actorUserId: null,
        eventType: "CASE_AUTO_ASSIGNED",
        payload: {
          source,
          owner_user_id: row.owner_user_id
        }
      });
    }
    const escalation = escalationByCase.get(row.id);
    if (escalation && (escalation.level === "high" || escalation.level === "critical")) {
      await appendExceptionCaseEvent({
        supabase,
        orgId,
        exceptionCaseId: row.id,
        actorUserId: null,
        eventType: "CASE_ESCALATED",
        payload: {
          source,
          level: escalation.level,
          overdue_hours: escalation.overdueHours
        }
      });
    }
  }

  const runtimeCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  const channel = runtimeCfg.alertChannelId || runtimeCfg.approvalChannelId;
  if (!runtimeCfg.botToken || !channel) {
    return {
      sent: false,
      reason: "slack_not_configured" as const,
      targetCount: targets.length,
      targetIds,
      autoAssignedCount: autoAssignedTargets.length,
      escalationCounts
    };
  }

  const taskIds = Array.from(new Set(targets.map((row) => row.task_id).filter((v): v is string => Boolean(v))));
  const taskMap = new Map<string, { id: string; title: string }>();
  if (taskIds.length > 0) {
    const { data: tasks } = await supabase.from("tasks").select("id, title").eq("org_id", orgId).in("id", taskIds);
    for (const task of tasks ?? []) {
      taskMap.set(task.id as string, {
        id: task.id as string,
        title: task.title as string
      });
    }
  }

  const appBase = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const lines = targets.slice(0, 10).map((row) => {
    const task = row.task_id ? taskMap.get(row.task_id) : null;
    const dueText = row.due_at ? new Date(row.due_at).toLocaleString() : "(no due)";
    const ownerText = row.owner_user_id ?? "unassigned";
    const link = row.task_id ? `${appBase}/app/tasks/${row.task_id}` : `${appBase}/app/operations/exceptions`;
    const escalation = escalationByCase.get(row.id);
    const lvl = escalation ? escalation.level.toUpperCase() : "LOW";
    const overdueText = escalation && escalation.overdueHours > 0 ? `${escalation.overdueHours}h overdue` : "not overdue";
    return `• [${lvl}] ${row.kind}/${row.ref_id} | owner=${ownerText} | due=${dueText} (${overdueText}) | ${task?.title ?? "-"} | ${link}`;
  });

  const message = await postSlackMessage({
    botToken: runtimeCfg.botToken,
    channel,
    text: `AI Agent OS Exception Alert: ${targets.length} exception cases require attention`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*AI Agent OS Exception Alert*\norg_id: ${orgId}\nsource: ${source}\n要対応ケース: ${targets.length}\n` +
            `critical=${escalationCounts.critical}, high=${escalationCounts.high}, medium=${escalationCounts.medium}, low=${escalationCounts.low}\n` +
            `auto_assigned=${autoAssignedTargets.length}`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: lines.join("\n")
        }
      }
    ]
  });

  const nowIso = new Date().toISOString();
  const ids = targets.map((row) => row.id);
  const { error: updateError } = await supabase
    .from("exception_cases")
    .update({
      last_alerted_at: nowIso,
      updated_at: nowIso
    })
    .eq("org_id", orgId)
    .in("id", ids);

  if (updateError) {
    throw new Error(`exception alert timestamp update failed: ${updateError.message}`);
  }

  for (const row of targets) {
    const escalation = escalationByCase.get(row.id);
    await appendExceptionCaseEvent({
      supabase,
      orgId,
      exceptionCaseId: row.id,
      actorUserId: null,
      eventType: "CASE_NOTIFICATION_SENT",
      payload: {
        source,
        level: escalation?.level ?? "low"
      }
    });
  }

  return {
    sent: true,
    reason: "posted" as const,
    targetCount: targets.length,
    targetIds,
    autoAssignedCount: autoAssignedTargets.length,
    escalationCounts,
    slackTs: message.ts,
    channel: message.channel,
    permalink: message.permalink ?? null
  };
}
