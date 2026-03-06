"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendCaseEventSafe } from "@/lib/cases/events";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function toErrorRedirect(message: string) {
  return `/app/tasks?error=${encodeURIComponent(message)}`;
}

function toOkRedirect(message: string) {
  return `/app/tasks?ok=${encodeURIComponent(message)}`;
}

export async function createTask(formData: FormData) {
  const agentId = String(formData.get("agent_id") ?? "").trim();
  const caseIdRaw = String(formData.get("case_id") ?? "").trim();
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

  let caseId: string | null = null;
  if (caseIdRaw) {
    const { data: foundCase, error: caseError } = await supabase
      .from("business_cases")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", caseIdRaw)
      .maybeSingle();
    if (caseError) {
      if (
        caseError.message.includes('relation "business_cases" does not exist') ||
        caseError.message.includes("Could not find the table 'public.business_cases'")
      ) {
        caseId = null;
      } else {
        redirect(toErrorRedirect(`案件の取得に失敗しました: ${caseError.message}`));
      }
    } else if (!foundCase?.id) {
      redirect(toErrorRedirect("指定された案件が見つかりません。"));
    } else {
      caseId = foundCase.id as string;
    }
  }

  let { data: createdTask, error: createError } = await supabase
    .from("tasks")
    .insert({
      org_id: orgId,
      created_by_user_id: userId,
      agent_id: agentId,
      case_id: caseId,
      workflow_template_id: workflowTemplateId || null,
      title,
      input_text: inputText,
      status: "draft"
    })
    .select("id, title, status, agent_id, case_id, workflow_template_id")
    .single();

  if (
    createError &&
    (createError.message.includes("Could not find the 'workflow_template_id' column") ||
      createError.message.includes("column tasks.workflow_template_id does not exist") ||
      createError.message.includes("Could not find the 'case_id' column") ||
      createError.message.includes("column tasks.case_id does not exist"))
  ) {
    const retry = await supabase
      .from("tasks")
      .insert({
        org_id: orgId,
        created_by_user_id: userId,
        agent_id: agentId,
        case_id: caseId,
        title,
        input_text: inputText,
        status: "draft"
      })
      .select("id, title, status, agent_id, case_id")
      .single();
    if (
      retry.error &&
      (retry.error.message.includes("Could not find the 'case_id' column") ||
        retry.error.message.includes("column tasks.case_id does not exist"))
    ) {
      const retryWithoutCase = await supabase
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
      createdTask = retryWithoutCase.data as typeof createdTask;
      createError = retryWithoutCase.error;
    } else {
      createdTask = retry.data as typeof createdTask;
      createError = retry.error;
    }
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
        case_id: (createdTask as { case_id?: string | null }).case_id ?? null,
        workflow_template_id: (createdTask as { workflow_template_id?: string | null }).workflow_template_id ?? null,
        source: "web_manual"
      }
    }
  });

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId,
    actorUserId: userId,
    eventType: "CASE_TASK_LINKED",
    payload: {
      task_id: createdTaskId,
      task_title: createdTask.title as string,
      task_status: createdTask.status as string,
      source: "task_create"
    }
  });

  revalidatePath("/app/tasks");
  redirect(toOkRedirect("タスクを作成しました。"));
}
