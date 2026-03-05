"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
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
    .select("id, status")
    .eq("id", taskId)
    .eq("org_id", orgId)
    .single();

  if (taskError) {
    redirect(errorPath(taskId, taskError.message));
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
