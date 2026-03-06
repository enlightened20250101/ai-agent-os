import type { SupabaseClient } from "@supabase/supabase-js";
import { appendCaseEventSafe, getCaseIdForTask } from "@/lib/cases/events";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { recordTrustOutcome } from "@/lib/governance/trust";

type Decision = "approved" | "rejected";

type DecideApprovalParams = {
  supabase: SupabaseClient;
  approvalId: string;
  decision: Decision;
  reason?: string | null;
  actorType: "user" | "system";
  actorId?: string | null;
  source: "web" | "slack" | "chat";
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

function parseLatestDraftAction(payload: unknown): { provider: "google"; actionType: "send_email" } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const eventPayload = payload as Record<string, unknown>;
  const output = eventPayload.output;
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const draft = output as Record<string, unknown>;
  const proposedActions = draft.proposed_actions;
  if (!Array.isArray(proposedActions) || proposedActions.length === 0) {
    return null;
  }
  const first = proposedActions[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }
  const action = first as Record<string, unknown>;
  if (action.provider !== "google" || action.action_type !== "send_email") {
    return null;
  }
  return { provider: "google", actionType: "send_email" };
}

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

  const caseId = await getCaseIdForTask({ supabase, orgId, taskId });
  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId,
    actorUserId: actorType === "user" ? actorId : null,
    eventType: "CASE_APPROVAL_DECIDED",
    payload: {
      approval_id: approvalId,
      decision,
      reason: reason || null,
      source
    }
  });
  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId,
    actorUserId: actorType === "user" ? actorId : null,
    eventType: "CASE_TASK_STATUS_SYNC",
    payload: {
      task_id: taskId,
      changed_fields: {
        status: {
          from: task.status as string,
          to: nextTaskStatus
        }
      },
      source: `approval_decision_${source}`
    }
  });

  if (decision === "rejected") {
    try {
      const [{ data: latestModelEvent }, { data: taskRow }] = await Promise.all([
        supabase
          .from("task_events")
          .select("payload_json")
          .eq("org_id", orgId)
          .eq("task_id", taskId)
          .eq("event_type", "MODEL_INFERRED")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("tasks")
          .select("agent_id")
          .eq("id", taskId)
          .eq("org_id", orgId)
          .maybeSingle()
      ]);

      const parsedAction = parseLatestDraftAction(latestModelEvent?.payload_json);
      if (parsedAction) {
        let agentRoleKey: string | null = null;
        const agentId = (taskRow?.agent_id as string | undefined) ?? null;
        if (agentId) {
          const { data: agentRes } = await supabase
            .from("agents")
            .select("role_key")
            .eq("id", agentId)
            .eq("org_id", orgId)
            .maybeSingle();
          agentRoleKey = (agentRes?.role_key as string | undefined) ?? null;
        }

        await recordTrustOutcome({
          supabase,
          orgId,
          provider: parsedAction.provider,
          actionType: parsedAction.actionType,
          outcome: "failed",
          agentRoleKey,
          taskId,
          source: "approval_rejection"
        });
      }
    } catch (trustError) {
      const message = trustError instanceof Error ? trustError.message : "unknown_trust_error";
      console.error(`[TRUST_REJECTION_UPDATE_FAILED] approval_id=${approvalId} task_id=${taskId} ${message}`);
    }
  }

  return {
    approvalId,
    orgId,
    taskId,
    approvalStatus: decision,
    taskStatus: nextTaskStatus
  };
}
