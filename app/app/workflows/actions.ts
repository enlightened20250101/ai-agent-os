"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toUserActionableError } from "@/lib/ui/actionableError";
import { advanceWorkflowRun, retryFailedWorkflowRun, startWorkflowRun } from "@/lib/workflows/orchestrator";

function toError(path: string, message: string) {
  return `${path}?error=${encodeURIComponent(message)}`;
}

function isMissingColumnError(message: string, columnName: string) {
  return (
    message.includes(`Could not find the '${columnName}' column`) ||
    message.includes(`column tasks.${columnName} does not exist`)
  );
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function parseSteps(raw: string) {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return [
      {
        key: "step_1",
        title: "Default step",
        type: "task_event"
      }
    ];
  }

  return lines.map((line, idx) => {
    const [titleRaw, typeRaw, requiresApprovalRaw] = line.split("|").map((part) => part.trim());
    const title = titleRaw || `step_${idx + 1}`;
    const type = typeRaw || "task_event";
    const requiresApproval = requiresApprovalRaw === "true";
    return {
      key: `step_${idx + 1}`,
      title,
      type,
      requires_approval: requiresApproval
    };
  });
}

export async function createWorkflowTemplate(formData: FormData) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const name = String(formData.get("name") ?? "").trim();
  const stepText = String(formData.get("steps") ?? "").trim();

  if (!name) {
    redirect(toError("/app/workflows", "テンプレート名は必須です。"));
  }

  const definition = {
    steps: parseSteps(stepText)
  };

  const { error } = await supabase.from("workflow_templates").insert({
    org_id: orgId,
    name,
    version: 1,
    definition_json: definition
  });

  if (error) {
    if (isMissingTableError(error.message, "workflow_templates")) {
      redirect(toError("/app/workflows", "workflow migration が未適用です。先に Supabase migration を実行してください。"));
    }
    redirect(toError("/app/workflows", `テンプレート作成に失敗しました: ${error.message}`));
  }

  revalidatePath("/app/workflows");
  revalidatePath("/app/tasks");
  redirect(`/app/workflows?ok=${encodeURIComponent("テンプレートを作成しました。")}`);
}

export async function startWorkflowRunFromTask(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const taskId = String(formData.get("task_id") ?? "").trim();
  let templateId = String(formData.get("template_id") ?? "").trim();
  if (!taskId) {
    redirect(toError("/app/tasks", "task_id がありません。"));
  }

  if (!templateId) {
    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("workflow_template_id")
      .eq("id", taskId)
      .eq("org_id", orgId)
      .single();

    if (taskError && !isMissingColumnError(taskError.message, "workflow_template_id")) {
      redirect(toError(`/app/tasks/${taskId}`, `タスク取得に失敗しました: ${taskError.message}`));
    }

    templateId = (task?.workflow_template_id as string) ?? "";
  }

  if (!templateId) {
    redirect(toError(`/app/tasks/${taskId}`, "workflow template を選択してください。"));
  }

  try {
    await startWorkflowRun({
      supabase,
      orgId,
      taskId,
      templateId,
      actorId: userId
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "workflow run 開始に失敗しました。";
    const message = toUserActionableError(rawMessage, "workflow_start");
    redirect(toError(`/app/tasks/${taskId}`, message));
  }

  revalidatePath(`/app/tasks/${taskId}`);
  revalidatePath("/app/workflows/runs");
  redirect(`/app/workflows/runs?ok=${encodeURIComponent("workflow run を開始しました。")}`);
}

export async function advanceWorkflowRunAction(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const workflowRunId = String(formData.get("workflow_run_id") ?? "").trim();
  if (!workflowRunId) {
    redirect(toError("/app/workflows/runs", "workflow_run_id がありません。"));
  }

  try {
    await advanceWorkflowRun({
      supabase,
      orgId,
      workflowRunId,
      actorId: userId
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "workflow step 進行に失敗しました。";
    const message = toUserActionableError(rawMessage, "workflow_advance");
    redirect(toError(`/app/workflows/runs/${workflowRunId}`, message));
  }

  revalidatePath("/app/workflows/runs");
  revalidatePath(`/app/workflows/runs/${workflowRunId}`);
  redirect(`/app/workflows/runs/${workflowRunId}?ok=${encodeURIComponent("workflow step を進めました。")}`);
}

export async function retryWorkflowRunAction(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const workflowRunId = String(formData.get("workflow_run_id") ?? "").trim();
  if (!workflowRunId) {
    redirect(toError("/app/workflows/runs", "workflow_run_id がありません。"));
  }

  try {
    await retryFailedWorkflowRun({
      supabase,
      orgId,
      workflowRunId,
      actorId: userId
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "workflow run 再試行に失敗しました。";
    const message = toUserActionableError(rawMessage, "workflow_retry");
    redirect(toError(`/app/workflows/runs/${workflowRunId}`, message));
  }

  revalidatePath("/app/workflows/runs");
  revalidatePath(`/app/workflows/runs/${workflowRunId}`);
  redirect(`/app/workflows/runs/${workflowRunId}?ok=${encodeURIComponent("workflow run を再試行しました。")}`);
}
