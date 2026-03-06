import type { SupabaseClient } from "@supabase/supabase-js";

export async function appendAiExecutionLog(args: {
  supabase: SupabaseClient;
  orgId: string;
  triggeredByUserId?: string | null;
  sessionId?: string | null;
  sessionScope?: string | null;
  channelId?: string | null;
  intentType?: string | null;
  executionStatus: "pending" | "running" | "done" | "failed" | "cancelled" | "declined" | "skipped";
  executionRefType?: string | null;
  executionRefId?: string | null;
  source?: string;
  summaryText?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string | null;
  finishedAt?: string | null;
}) {
  const {
    supabase,
    orgId,
    triggeredByUserId = null,
    sessionId = null,
    sessionScope = null,
    channelId = null,
    intentType = null,
    executionStatus,
    executionRefType = null,
    executionRefId = null,
    source = "chat",
    summaryText = null,
    metadata = {},
    createdAt = null,
    finishedAt = null
  } = args;

  const { error } = await supabase.from("ai_execution_logs").insert({
    org_id: orgId,
    triggered_by_user_id: triggeredByUserId,
    session_id: sessionId,
    session_scope: sessionScope,
    channel_id: channelId,
    intent_type: intentType,
    execution_status: executionStatus,
    execution_ref_type: executionRefType,
    execution_ref_id: executionRefId,
    source,
    summary_text: summaryText,
    metadata_json: metadata,
    created_at: createdAt ?? new Date().toISOString(),
    finished_at: finishedAt
  });

  if (error) {
    const missingTable =
      error.message.includes('relation "ai_execution_logs" does not exist') ||
      error.message.includes("Could not find the table 'public.ai_execution_logs'");
    if (missingTable) return false;
    throw new Error(`Failed to append AI execution log: ${error.message}`);
  }

  return true;
}
