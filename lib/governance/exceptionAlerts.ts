import type { SupabaseClient } from "@supabase/supabase-js";
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

  const runtimeCfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  const channel = runtimeCfg.alertChannelId || runtimeCfg.approvalChannelId;
  if (!runtimeCfg.botToken || !channel) {
    return { sent: false, reason: "slack_not_configured" as const, targetCount: targets.length, targetIds };
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
    return `• ${row.kind}/${row.ref_id} | owner=${ownerText} | due=${dueText} | ${task?.title ?? "-"} | ${link}`;
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
          text: `*AI Agent OS Exception Alert*\norg_id: ${orgId}\nsource: ${source}\n要対応ケース: ${targets.length}`
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

  return {
    sent: true,
    reason: "posted" as const,
    targetCount: targets.length,
    targetIds,
    slackTs: message.ts,
    channel: message.channel,
    permalink: message.permalink ?? null
  };
}
