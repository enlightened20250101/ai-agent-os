import type { SupabaseClient } from "@supabase/supabase-js";

export type AppEventType =
  | "ORG_CREATED"
  | "MEMBERSHIP_CREATED"
  | "AGENT_CREATED"
  | "AGENT_UPDATED"
  | "TASK_CREATED"
  | "TASK_UPDATED"
  | "SLACK_TASK_INTAKE"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_BLOCKED"
  | "APPROVAL_BYPASSED"
  | "SLACK_APPROVAL_POSTED"
  | "HUMAN_APPROVED"
  | "HUMAN_REJECTED"
  | "MODEL_INFERRED"
  | "POLICY_CHECKED"
  | "ACTION_QUEUED"
  | "ACTION_SKIPPED"
  | "ACTION_EXECUTED"
  | "ACTION_FAILED"
  | "WORKFLOW_STARTED"
  | "WORKFLOW_STEP_STARTED"
  | "WORKFLOW_STEP_COMPLETED"
  | "WORKFLOW_RETRIED"
  | "WORKFLOW_COMPLETED"
  | "WORKFLOW_FAILED"
  | "INCIDENT_DECLARED"
  | "INCIDENT_RESOLVED"
  | "GOVERNANCE_RECOMMENDATION_APPLIED"
  | "GOVERNANCE_RECOMMENDATION_FAILED"
  | "GOVERNANCE_RECOMMENDATIONS_REVIEWED"
  | "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"
  | "CHAT_QUICK_ACTION_USED"
  | "OPS_ALERT_POSTED"
  | "OPS_ALERT_FAILED"
  | "OPS_JOB_RETRY_SCHEDULED"
  | "OPS_JOB_RETRY_RECOVERED"
  | "OPS_JOB_RETRY_EXHAUSTED"
  | "OPS_JOB_SKIPPED_CIRCUIT_OPEN"
  | "OPS_JOB_CIRCUIT_OPENED"
  | "OPS_JOB_CIRCUIT_CLOSED"
  | "OPS_JOB_CIRCUIT_MANUALLY_CLEARED"
  | "OPS_JOB_DRY_RUN_PASSED"
  | "OPS_JOB_DRY_RUN_FAILED"
  | "OPS_JOB_CIRCUIT_ALERT_POSTED"
  | "OPS_JOB_CIRCUIT_ALERT_FAILED"
  | "APPROVAL_REMINDER_AUTO_RUN"
  | "APPROVAL_REMINDER_AUTO_SKIPPED";

type AppendTaskEventArgs = {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
  actorType?: "user" | "agent" | "system";
  actorId?: string | null;
  eventType: AppEventType;
  payload: Record<string, unknown>;
};

export const AGENT_EVENTS_TASK_TITLE = "__SYSTEM_AGENT_EVENTS__";

export async function appendTaskEvent({
  supabase,
  orgId,
  taskId,
  actorType = "user",
  actorId = null,
  eventType,
  payload
}: AppendTaskEventArgs) {
  const { error } = await supabase.from("task_events").insert({
    org_id: orgId,
    task_id: taskId,
    actor_type: actorType,
    actor_id: actorId,
    event_type: eventType,
    payload_json: payload
  });

  if (error) {
    throw new Error(`Failed to append event ${eventType}: ${error.message}`);
  }
}

type AgentOpsTaskArgs = {
  supabase: SupabaseClient;
  orgId: string;
  userId: string;
};

export async function getOrCreateAgentOpsTaskId({ supabase, orgId, userId }: AgentOpsTaskArgs) {
  const { data: existingTask, error: lookupError } = await supabase
    .from("tasks")
    .select("id")
    .eq("org_id", orgId)
    .eq("title", AGENT_EVENTS_TASK_TITLE)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Failed to load system agent event task: ${lookupError.message}`);
  }

  if (existingTask?.id) {
    return existingTask.id as string;
  }

  const { data: createdTask, error: createError } = await supabase
    .from("tasks")
    .insert({
      org_id: orgId,
      created_by_user_id: userId,
      title: AGENT_EVENTS_TASK_TITLE,
      input_text: "Internal task for non-task agent lifecycle events.",
      status: "done"
    })
    .select("id")
    .single();

  if (createError) {
    throw new Error(`Failed to create system agent event task: ${createError.message}`);
  }

  return createdTask.id as string;
}
