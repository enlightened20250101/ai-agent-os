import type { SupabaseClient } from "@supabase/supabase-js";

export type CaseEventType =
  | "CASE_CREATED"
  | "CASE_CREATED_FROM_EXTERNAL_EVENT"
  | "CASE_STATUS_UPDATED"
  | "CASE_OWNER_UPDATED"
  | "CASE_DUE_UPDATED"
  | "CASE_TASK_LINKED"
  | "CASE_TASK_STATUS_SYNC"
  | "CASE_APPROVAL_DECIDED"
  | "CASE_STAGE_SYNCED";

function isMissingSchemaError(message: string, target: string) {
  return (
    message.includes(`relation "${target}" does not exist`) ||
    message.includes(`Could not find the table 'public.${target}'`) ||
    message.includes(`column ${target} does not exist`) ||
    message.includes(`column "${target}" does not exist`)
  );
}

export async function getCaseIdForTask(args: {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
}) {
  const { supabase, orgId, taskId } = args;
  const { data, error } = await supabase
    .from("tasks")
    .select("case_id")
    .eq("org_id", orgId)
    .eq("id", taskId)
    .maybeSingle();

  if (error) {
    if (isMissingSchemaError(error.message, "tasks") || isMissingSchemaError(error.message, "tasks.case_id")) {
      return null;
    }
    throw new Error(`Failed to load task case link: ${error.message}`);
  }
  return (data?.case_id as string | null | undefined) ?? null;
}

export async function appendCaseEventSafe(args: {
  supabase: SupabaseClient;
  orgId: string;
  caseId: string | null;
  actorUserId?: string | null;
  eventType: CaseEventType;
  payload?: Record<string, unknown>;
}) {
  const { supabase, orgId, caseId, actorUserId = null, eventType, payload = {} } = args;
  if (!caseId) {
    return false;
  }

  const { error } = await supabase.from("case_events").insert({
    org_id: orgId,
    case_id: caseId,
    actor_user_id: actorUserId,
    event_type: eventType,
    payload_json: payload
  });

  if (error) {
    if (isMissingSchemaError(error.message, "case_events")) {
      return false;
    }
    console.error(`[CASE_EVENT_APPEND_FAILED] case_id=${caseId} type=${eventType} ${error.message}`);
    return false;
  }
  return true;
}
