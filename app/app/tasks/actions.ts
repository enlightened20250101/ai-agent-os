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
  const workflowTemplateId = String(formData.get("workflow_template_id") ?? "").trim();

  if (!agentId || !title) {
    redirect(toErrorRedirect("agent_id と title は必須です。"));
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
    redirect(toErrorRedirect(`無効なエージェントです: ${agentError.message}`));
  }

  if (agent.status !== "active") {
    redirect(toErrorRedirect("タスクに指定するエージェントは active である必要があります。"));
  }

  let { data: createdTask, error: createError } = await supabase
    .from("tasks")
    .insert({
      org_id: orgId,
      created_by_user_id: userId,
      agent_id: agentId,
      workflow_template_id: workflowTemplateId || null,
      title,
      input_text: inputText,
      status: "draft"
    })
    .select("id, title, status, agent_id, workflow_template_id")
    .single();

  if (
    createError &&
    (createError.message.includes("Could not find the 'workflow_template_id' column") ||
      createError.message.includes("column tasks.workflow_template_id does not exist"))
  ) {
    const retry = await supabase
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
    createdTask = retry.data as typeof createdTask;
    createError = retry.error;
  }

  if (createError) {
    redirect(toErrorRedirect(createError.message));
  }
  if (!createdTask?.id) {
    redirect(toErrorRedirect("タスク作成結果が不正です。"));
  }
  const createdTaskId = createdTask.id as string;

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: createdTaskId,
    actorId: userId,
    eventType: "TASK_CREATED",
    payload: {
      changed_fields: {
        title: createdTask.title,
        status: createdTask.status,
        agent_id: createdTask.agent_id,
        workflow_template_id: (createdTask as { workflow_template_id?: string | null }).workflow_template_id ?? null,
        source: "web_manual"
      }
    }
  });

  revalidatePath("/app/tasks");
}
