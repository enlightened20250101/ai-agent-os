import type { SupabaseClient } from "@supabase/supabase-js";

export type ExceptionCaseEventType =
  | "CASE_CREATED"
  | "CASE_UPDATED"
  | "CASE_BULK_UPDATED"
  | "CASE_NOTIFICATION_SENT"
  | "CASE_AUTO_ASSIGNED"
  | "CASE_ESCALATED";

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export async function appendExceptionCaseEvent(args: {
  supabase: SupabaseClient;
  orgId: string;
  exceptionCaseId: string;
  actorUserId?: string | null;
  eventType: ExceptionCaseEventType;
  payload: Record<string, unknown>;
}) {
  const { supabase, orgId, exceptionCaseId, actorUserId = null, eventType, payload } = args;
  const { error } = await supabase.from("exception_case_events").insert({
    org_id: orgId,
    exception_case_id: exceptionCaseId,
    actor_user_id: actorUserId,
    event_type: eventType,
    payload_json: payload
  });

  if (!error) {
    return { written: true as const };
  }
  if (isMissingTableError(error.message, "exception_case_events")) {
    return { written: false as const, reason: "missing_table" as const };
  }
  throw new Error(`exception_case_event insert failed: ${error.message}`);
}
