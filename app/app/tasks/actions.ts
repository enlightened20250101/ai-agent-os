"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function toErrorRedirect(message: string) {
  return `/app/tasks?error=${encodeURIComponent(message)}`;
}

export async function createTask(formData: FormData) {
  const agentId = String(formData.get("agent_id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const inputText = String(formData.get("input_text") ?? "").trim();

  if (!agentId || !title) {
    redirect(toErrorRedirect("Agent and title are required."));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, status")
    .eq("id", agentId)
    .eq("org_id", orgId)
    .single();

  if (agentError) {
    redirect(toErrorRedirect(`Invalid agent: ${agentError.message}`));
  }

  if (agent.status !== "active") {
    redirect(toErrorRedirect("Task agent must be active."));
  }

  const { data: createdTask, error: createError } = await supabase
    .from("tasks")
    .insert({
      org_id: orgId,
      created_by_user_id: userId,
      agent_id: agentId,
      title,
      input_text: inputText,
      status: "draft"
    })
    .select("id, title, status, agent_id")
    .single();

  if (createError) {
    redirect(toErrorRedirect(createError.message));
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: createdTask.id as string,
    actorId: userId,
    eventType: "TASK_CREATED",
    payload: {
      changed_fields: {
        title: createdTask.title,
        status: createdTask.status,
        agent_id: createdTask.agent_id
      }
    }
  });

  revalidatePath("/app/tasks");
}
