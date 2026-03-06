import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingChatSchemaError } from "@/lib/chat/schema";
import { getOrCreateChatSession } from "@/lib/chat/sessions";
import { buildMonitorNextActions, type MonitorSignalCounts } from "@/lib/monitor/recommendations";

type SignalSamples = {
  stale_tasks: Array<{ id: string; title: string }>;
  stale_approval_task_ids: string[];
  failed_action_task_ids: string[];
  stale_cases: Array<{ id: string; title: string }>;
  policy_warn_block_task_ids: string[];
};

type PostMonitorNudgeArgs = {
  supabase: SupabaseClient;
  orgId: string;
  monitorRunId: string;
  signalCounts: MonitorSignalCounts;
  signalSamples: SignalSamples;
  plannerInvoked: boolean;
  createdProposals: number;
  status: "completed" | "failed" | "skipped";
  errorMessage?: string | null;
};

function shouldEnableNudge() {
  const raw = (process.env.MONITOR_CHAT_NUDGE_ENABLED ?? "1").trim();
  return raw !== "0";
}

function hasSignals(signalCounts: MonitorSignalCounts) {
  return Object.values(signalCounts).some((value) => value > 0);
}

function buildBodyText(args: Omit<PostMonitorNudgeArgs, "supabase" | "orgId">) {
  const actionHints = buildMonitorNextActions({
    signalCounts: args.signalCounts,
    recoverySummary: null
  }).map((item) => item.chatHint);

  const lines = [
    `@AI 監視ティック結果: ${args.status}`,
    `- stale_tasks: ${args.signalCounts.stale_tasks}`,
    `- stale_pending_approvals: ${args.signalCounts.stale_pending_approvals}`,
    `- recent_action_failures: ${args.signalCounts.recent_action_failures}`,
    `- stale_open_cases: ${args.signalCounts.stale_open_cases}`,
    `- policy_warn_block_24h: ${args.signalCounts.policy_warn_block_24h}`,
    `- new_inbound_events_24h: ${args.signalCounts.new_inbound_events_24h}`
  ];
  if (args.plannerInvoked) {
    lines.push(`- planner_invoked: yes (created_proposals=${args.createdProposals})`);
  } else {
    lines.push("- planner_invoked: no");
  }
  if (args.errorMessage) {
    lines.push(`- error: ${args.errorMessage}`);
  }
  if (args.signalSamples.stale_tasks.length > 0) {
    lines.push(
      `- stale_task_examples: ${args.signalSamples.stale_tasks
        .map((item) => `${item.title} (/app/tasks/${item.id})`)
        .join(" / ")}`
    );
  }
  if (args.signalSamples.stale_cases.length > 0) {
    lines.push(
      `- stale_case_examples: ${args.signalSamples.stale_cases
        .map((item) => `${item.title} (/app/cases/${item.id})`)
        .join(" / ")}`
    );
  }
  if (args.signalSamples.failed_action_task_ids.length > 0) {
    lines.push(
      `- failed_task_samples: ${args.signalSamples.failed_action_task_ids
        .map((taskId) => `/app/tasks/${taskId}`)
        .join(", ")}`
    );
  }
  if (args.signalSamples.stale_approval_task_ids.length > 0) {
    lines.push(
      `- stale_approval_tasks: ${args.signalSamples.stale_approval_task_ids
        .map((taskId) => `/app/tasks/${taskId}`)
        .join(", ")}`
    );
  }
  if (actionHints.length > 0) {
    lines.push("- next_actions:");
    for (const hint of actionHints.slice(0, 3)) {
      lines.push(`  - ${hint}`);
    }
  }
  lines.push("推奨: /app/operations/exceptions と /app/approvals を確認して、詰まり案件を優先解消してください。");
  lines.push("外部イベント確認: /app/events?status=new");
  lines.push("ショートカット: /app/monitor の「即時回収アクション」から承認催促・再試行・担当割当を実行できます。");
  lines.push('チャット例: `@AI 承認待ちを3件まとめて承認` / `@AI 失敗ワークフローを3件再試行` / `@AI 案件「◯◯」を自分に割り当て`');
  return lines.join("\n");
}

export async function postMonitorNudgeToSharedChat(args: PostMonitorNudgeArgs) {
  if (!shouldEnableNudge()) return { posted: false, reason: "disabled" as const };
  if (!hasSignals(args.signalCounts)) return { posted: false, reason: "no_signals" as const };

  const { supabase, orgId } = args;
  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membershipError) {
    return { posted: false, reason: `membership_lookup_failed:${membershipError.message}` as const };
  }
  const userId = membership?.user_id as string | undefined;
  if (!userId) return { posted: false, reason: "no_member" as const };

  try {
    const session = await getOrCreateChatSession({
      supabase,
      orgId,
      scope: "shared",
      userId
    });
    const bodyText = buildBodyText({
      monitorRunId: args.monitorRunId,
      signalCounts: args.signalCounts,
      signalSamples: args.signalSamples,
      plannerInvoked: args.plannerInvoked,
      createdProposals: args.createdProposals,
      status: args.status,
      errorMessage: args.errorMessage ?? null
    });
    const { error: insertError } = await supabase.from("chat_messages").insert({
      org_id: orgId,
      session_id: session.id,
      sender_type: "system",
      sender_user_id: null,
      body_text: bodyText,
      metadata_json: {
        source: "monitor_tick",
        monitor_run_id: args.monitorRunId,
        planner_invoked: args.plannerInvoked,
        created_proposals: args.createdProposals,
        signal_counts: args.signalCounts,
        signal_samples: args.signalSamples
      }
    });
    if (insertError) {
      if (isMissingChatSchemaError(insertError.message)) {
        return { posted: false, reason: "chat_schema_missing" as const };
      }
      return { posted: false, reason: `chat_insert_failed:${insertError.message}` as const };
    }
    return { posted: true, reason: null as null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "chat_nudge_failed";
    if (isMissingChatSchemaError(message)) {
      return { posted: false, reason: "chat_schema_missing" as const };
    }
    return { posted: false, reason: `chat_nudge_failed:${message}` as const };
  }
}
