import type { SupabaseClient } from "@supabase/supabase-js";
import { appendCaseEventSafe, getCaseIdForTask } from "@/lib/cases/events";
import { deriveCaseStage, summarizeTaskStatuses } from "@/lib/cases/stage";

type SyncCaseStageForTaskArgs = {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
  actorUserId?: string | null;
  source: string;
};

function isMissingSchemaError(message: string, target: string) {
  return (
    message.includes(`relation "${target}" does not exist`) ||
    message.includes(`Could not find the table 'public.${target}'`) ||
    message.includes(`column ${target} does not exist`) ||
    message.includes(`column "${target}" does not exist`)
  );
}

export async function syncCaseStageForTask(args: SyncCaseStageForTaskArgs) {
  const { supabase, orgId, taskId, actorUserId = null, source } = args;
  const caseId = await getCaseIdForTask({ supabase, orgId, taskId });
  if (!caseId) {
    return { synced: false as const, reason: "no_case" as const };
  }

  const [{ data: caseRow, error: caseError }, { data: tasks, error: tasksError }] = await Promise.all([
    supabase
      .from("business_cases")
      .select("id, status, stage")
      .eq("org_id", orgId)
      .eq("id", caseId)
      .maybeSingle(),
    supabase.from("tasks").select("status").eq("org_id", orgId).eq("case_id", caseId)
  ]);

  if (caseError) {
    if (isMissingSchemaError(caseError.message, "business_cases") || isMissingSchemaError(caseError.message, "business_cases.stage")) {
      return { synced: false as const, reason: "missing_schema" as const };
    }
    throw new Error(`Failed to load case for stage sync: ${caseError.message}`);
  }
  if (!caseRow) {
    return { synced: false as const, reason: "case_not_found" as const };
  }

  if (tasksError) {
    if (isMissingSchemaError(tasksError.message, "tasks") || isMissingSchemaError(tasksError.message, "tasks.case_id")) {
      return { synced: false as const, reason: "missing_schema" as const };
    }
    throw new Error(`Failed to load task statuses for stage sync: ${tasksError.message}`);
  }

  const statuses = (tasks ?? []).map((row) => String(row.status ?? "")).filter(Boolean);
  const nextStage = deriveCaseStage({
    caseStatus: (caseRow.status as "open" | "blocked" | "closed") ?? "open",
    taskStatuses: statuses
  });
  const currentStage = (caseRow.stage as string | null) ?? "intake";

  if (currentStage === nextStage) {
    return { synced: false as const, reason: "unchanged" as const, caseId, stage: currentStage };
  }

  const { error: updateError } = await supabase
    .from("business_cases")
    .update({ stage: nextStage, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", caseId);

  if (updateError) {
    if (isMissingSchemaError(updateError.message, "business_cases") || isMissingSchemaError(updateError.message, "business_cases.stage")) {
      return { synced: false as const, reason: "missing_schema" as const };
    }
    throw new Error(`Failed to update case stage: ${updateError.message}`);
  }

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId,
    actorUserId,
    eventType: "CASE_STAGE_SYNCED",
    payload: {
      changed_fields: {
        stage: {
          from: currentStage,
          to: nextStage
        }
      },
      task_status_summary: summarizeTaskStatuses(statuses),
      source,
      trigger_task_id: taskId
    }
  });

  return { synced: true as const, caseId, stage: nextStage };
}
