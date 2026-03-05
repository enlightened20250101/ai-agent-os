import type { SupabaseClient } from "@supabase/supabase-js";
import { appendTaskEvent } from "@/lib/events/taskEvents";

type Decision = "approved" | "rejected";

type DecideApprovalParams = {
  supabase: SupabaseClient;
  approvalId: string;
  decision: Decision;
  reason?: string | null;
  actorType: "user" | "system";
  actorId?: string | null;
  source: "web" | "slack";
  expectedOrgId?: string;
  slackUserId?: string | null;
};

export type DecideApprovalResult = {
  approvalId: string;
  orgId: string;
  taskId: string;
  approvalStatus: Decision;
  taskStatus: "approved" | "draft";
};

export async function decideApprovalShared(params: DecideApprovalParams): Promise<DecideApprovalResult> {
  const {
    supabase,
    approvalId,
    decision,
    reason,
    actorType,
    actorId = null,
    source,
    expectedOrgId,
    slackUserId = null
  } = params;

  const { data: approval, error: approvalLookupError } = await supabase
    .from("approvals")
    .select("id, org_id, task_id, status")
    .eq("id", approvalId)
    .single();

  if (approvalLookupError) {
    throw new Error(`Approval lookup failed: ${approvalLookupError.message}`);
  }

  const orgId = approval.org_id as string;
  const taskId = approval.task_id as string;

  if (expectedOrgId && orgId !== expectedOrgId) {
    throw new Error("Approval does not belong to active org.");
  }

  if (approval.status !== "pending") {
    throw new Error("This approval has already been decided.");
  }

  const { error: approvalUpdateError } = await supabase
    .from("approvals")
    .update({
      status: decision,
      reason: reason || null,
      approver_user_id: actorType === "user" ? actorId : null,
      decided_at: new Date().toISOString()
    })
    .eq("id", approvalId)
    .eq("org_id", orgId);

  if (approvalUpdateError) {
    throw new Error(`Approval update failed: ${approvalUpdateError.message}`);
  }

  const eventType = decision === "approved" ? "HUMAN_APPROVED" : "HUMAN_REJECTED";
  await appendTaskEvent({
    supabase,
    orgId,
    taskId,
    actorType,
    actorId,
    eventType,
    payload: {
      approval_id: approvalId,
      reason: reason || null,
      source,
      slack_user_id: slackUserId
    }
  });

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, status")
    .eq("id", taskId)
    .eq("org_id", orgId)
    .single();

  if (taskError) {
    throw new Error(`Task lookup failed: ${taskError.message}`);
  }

  const nextTaskStatus = decision === "approved" ? "approved" : "draft";
  const { error: taskUpdateError } = await supabase
    .from("tasks")
    .update({ status: nextTaskStatus })
    .eq("id", taskId)
    .eq("org_id", orgId);

  if (taskUpdateError) {
    throw new Error(`Task update failed: ${taskUpdateError.message}`);
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId,
    actorType,
    actorId,
    eventType: "TASK_UPDATED",
    payload: {
      changed_fields: {
        status: {
          from: task.status,
          to: nextTaskStatus
        }
      },
      source: `approval_decision_${source}`,
      approval_id: approvalId
    }
  });

  return {
    approvalId,
    orgId,
    taskId,
    approvalStatus: decision,
    taskStatus: nextTaskStatus
  };
}
