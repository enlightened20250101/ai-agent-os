"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function errorRedirect(message: string) {
  return `/app/approvals?error=${encodeURIComponent(message)}`;
}

async function assertDecisionEventExists(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  taskId: string;
  actorId: string;
  eventType: "HUMAN_APPROVED" | "HUMAN_REJECTED";
}) {
  const { supabase, orgId, taskId, actorId, eventType } = args;
  const { data, error } = await supabase
    .from("task_events")
    .select("id")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .eq("actor_type", "user")
    .eq("actor_id", actorId)
    .eq("event_type", eventType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    const detail = error ? error.message : "event row not found";
    throw new Error(`Failed to verify ${eventType} event write: ${detail}`);
  }
}

export async function decideApproval(formData: FormData) {
  const approvalId = String(formData.get("approval_id") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!approvalId || (decision !== "approved" && decision !== "rejected")) {
    redirect(errorRedirect("Invalid approval decision request."));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: approval, error: approvalLookupError } = await supabase
    .from("approvals")
    .select("id, task_id, status")
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .single();

  if (approvalLookupError) {
    redirect(errorRedirect(approvalLookupError.message));
  }

  if (approval.status !== "pending") {
    redirect(errorRedirect("This approval has already been decided."));
  }

  const { error: approvalUpdateError } = await supabase
    .from("approvals")
    .update({
      status: decision,
      reason: reason || null,
      approver_user_id: userId,
      decided_at: new Date().toISOString()
    })
    .eq("id", approvalId)
    .eq("org_id", orgId);

  if (approvalUpdateError) {
    redirect(errorRedirect(approvalUpdateError.message));
  }

  const eventType = decision === "approved" ? "HUMAN_APPROVED" : "HUMAN_REJECTED";
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: approval.task_id as string,
    actorId: userId,
    eventType,
    payload: {
      approval_id: approvalId,
      reason: reason || null
    }
  });

  await assertDecisionEventExists({
    supabase,
    orgId,
    taskId: approval.task_id as string,
    actorId: userId,
    eventType
  });

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, status")
    .eq("id", approval.task_id as string)
    .eq("org_id", orgId)
    .single();

  if (taskError) {
    redirect(errorRedirect(taskError.message));
  }

  const nextTaskStatus = decision === "approved" ? "approved" : "draft";
  const { error: taskUpdateError } = await supabase
    .from("tasks")
    .update({ status: nextTaskStatus })
    .eq("id", approval.task_id as string)
    .eq("org_id", orgId);

  if (taskUpdateError) {
    redirect(errorRedirect(taskUpdateError.message));
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: approval.task_id as string,
    actorId: userId,
    eventType: "TASK_UPDATED",
    payload: {
      changed_fields: {
        status: {
          from: task.status,
          to: nextTaskStatus
        }
      },
      source: "approval_decision",
      approval_id: approvalId
    }
  });

  revalidatePath("/app/approvals");
  revalidatePath("/app/tasks");
  revalidatePath(`/app/tasks/${approval.task_id as string}`);
}
