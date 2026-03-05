"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { generateDraftWithOpenAI } from "@/lib/llm/openai";
import { checkDraftPolicy } from "@/lib/policy/check";
import { createClient } from "@/lib/supabase/server";

function taskPath(taskId: string) {
  return `/app/tasks/${taskId}`;
}

function errorPath(taskId: string, message: string) {
  return `${taskPath(taskId)}?error=${encodeURIComponent(message)}`;
}

export async function setTaskReadyForApproval(formData: FormData) {
  const taskId = String(formData.get("task_id") ?? "").trim();
  if (!taskId) {
    redirect("/app/tasks?error=Missing+task+id");
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, status")
    .eq("id", taskId)
    .eq("org_id", orgId)
    .single();

  if (taskError) {
    redirect(errorPath(taskId, taskError.message));
  }

  if (task.status !== "ready_for_approval") {
    const { error: updateError } = await supabase
      .from("tasks")
      .update({ status: "ready_for_approval" })
      .eq("id", taskId)
      .eq("org_id", orgId);

    if (updateError) {
      redirect(errorPath(taskId, updateError.message));
    }

    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorId: userId,
      eventType: "TASK_UPDATED",
      payload: {
        changed_fields: {
          status: {
            from: task.status,
            to: "ready_for_approval"
          }
        },
        source: "manual_status_update"
      }
    });
  }

  revalidatePath(taskPath(taskId));
  revalidatePath("/app/tasks");
  revalidatePath("/app/approvals");
}

export async function requestApproval(formData: FormData) {
  const taskId = String(formData.get("task_id") ?? "").trim();
  if (!taskId) {
    redirect("/app/tasks?error=Missing+task+id");
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, status, title, input_text, agent_id")
    .eq("id", taskId)
    .eq("org_id", orgId)
    .single();

  if (taskError) {
    redirect(errorPath(taskId, taskError.message));
  }

  const { data: latestModelEvent, error: modelEventError } = await supabase
    .from("task_events")
    .select("id, payload_json")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .eq("event_type", "MODEL_INFERRED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (modelEventError) {
    redirect(errorPath(taskId, modelEventError.message));
  }
  if (!latestModelEvent) {
    redirect(errorPath(taskId, "Generate a draft before requesting approval."));
  }

  const { data: latestPolicyEvent, error: policyEventError } = await supabase
    .from("task_events")
    .select("id, payload_json")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .eq("event_type", "POLICY_CHECKED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (policyEventError) {
    redirect(errorPath(taskId, policyEventError.message));
  }
  if (!latestPolicyEvent) {
    redirect(errorPath(taskId, "Policy check missing. Generate a draft first."));
  }

  const policyPayload = latestPolicyEvent.payload_json as { status?: string } | null;
  if (policyPayload?.status === "block") {
    redirect(errorPath(taskId, "Policy status is block. Approval request is disabled."));
  }

  const { data: pendingApproval, error: pendingLookupError } = await supabase
    .from("approvals")
    .select("id")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  if (pendingLookupError) {
    redirect(errorPath(taskId, pendingLookupError.message));
  }

  if (pendingApproval?.id) {
    redirect(errorPath(taskId, "A pending approval already exists for this task."));
  }

  const { data: approval, error: approvalError } = await supabase
    .from("approvals")
    .insert({
      org_id: orgId,
      task_id: taskId,
      requested_by: userId,
      status: "pending"
    })
    .select("id")
    .single();

  if (approvalError) {
    redirect(errorPath(taskId, approvalError.message));
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId,
    actorId: userId,
    eventType: "APPROVAL_REQUESTED",
    payload: {
      approval_id: approval.id
    }
  });

  if (task.status !== "ready_for_approval") {
    const { error: statusUpdateError } = await supabase
      .from("tasks")
      .update({ status: "ready_for_approval" })
      .eq("id", taskId)
      .eq("org_id", orgId);

    if (statusUpdateError) {
      redirect(errorPath(taskId, statusUpdateError.message));
    }

    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorId: userId,
      eventType: "TASK_UPDATED",
      payload: {
        changed_fields: {
          status: {
            from: task.status,
            to: "ready_for_approval"
          }
        },
        source: "approval_request"
      }
    });
  }

  revalidatePath(taskPath(taskId));
  revalidatePath("/app/tasks");
  revalidatePath("/app/approvals");
}

export async function generateDraft(formData: FormData) {
  const taskId = String(formData.get("task_id") ?? "").trim();
  if (!taskId) {
    redirect("/app/tasks?error=Missing+task+id");
  }

  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, title, input_text, agent_id")
    .eq("id", taskId)
    .eq("org_id", orgId)
    .single();

  if (taskError) {
    redirect(errorPath(taskId, taskError.message));
  }

  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, role_key, name")
    .eq("id", task.agent_id as string)
    .eq("org_id", orgId)
    .single();

  if (agentError) {
    redirect(errorPath(taskId, `Agent lookup failed: ${agentError.message}`));
  }

  let inferredPayload: Record<string, unknown>;
  let draftOutput:
    | {
        summary: string;
        proposed_actions: Array<{
          provider: "google";
          action_type: "send_email";
          to: string;
          subject: string;
          body_text: string;
        }>;
        risks: string[];
      }
    | null = null;

  try {
    const result = await generateDraftWithOpenAI({
      roleKey: agent.role_key as string,
      title: task.title as string,
      inputText: task.input_text as string
    });
    draftOutput = result.output;
    inferredPayload = {
      model: result.model,
      latency_ms: result.latencyMs,
      output: result.output
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown model error.";
    inferredPayload = {
      error: {
        message
      }
    };
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId,
    actorType: "system",
    actorId: null,
    eventType: "MODEL_INFERRED",
    payload: inferredPayload
  });

  if (draftOutput) {
    const policy = checkDraftPolicy({ draft: draftOutput });
    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorType: "system",
      actorId: null,
      eventType: "POLICY_CHECKED",
      payload: {
        status: policy.result.status,
        reasons: policy.result.reasons,
        evaluated_action: policy.evaluatedAction
      }
    });
  }

  revalidatePath(taskPath(taskId));
  revalidatePath("/app/tasks");
  revalidatePath("/app/approvals");
}
