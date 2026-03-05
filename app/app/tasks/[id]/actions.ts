"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { executeTaskDraftActionShared } from "@/lib/actions/executeDraft";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { generateDraftWithOpenAI } from "@/lib/llm/openai";
import { checkDraftPolicy } from "@/lib/policy/check";
import { postApprovalRequestToSlack } from "@/lib/slack/approvals";
import { createClient } from "@/lib/supabase/server";

function taskPath(taskId: string) {
  return `/app/tasks/${taskId}`;
}

function errorPath(taskId: string, message: string) {
  return `${taskPath(taskId)}?error=${encodeURIComponent(message)}`;
}

function okPath(taskId: string, message: string) {
  return `${taskPath(taskId)}?ok=${encodeURIComponent(message)}`;
}

export async function setTaskReadyForApproval(formData: FormData) {
  const taskId = String(formData.get("task_id") ?? "").trim();
  if (!taskId) {
    redirect("/app/tasks?error=task_id+がありません");
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, status, agent_id")
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
  redirect(okPath(taskId, "タスクを承認待ちに更新しました。"));
}

export async function requestApproval(formData: FormData) {
  const taskId = String(formData.get("task_id") ?? "").trim();
  if (!taskId) {
    redirect("/app/tasks?error=task_id+がありません");
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
    redirect(errorPath(taskId, "承認依頼の前にドラフトを生成してください。"));
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
    redirect(errorPath(taskId, "ポリシーチェック結果がありません。先にドラフトを生成してください。"));
  }

  const policyPayload = latestPolicyEvent.payload_json as { status?: string } | null;
  if (policyPayload?.status === "block") {
    redirect(errorPath(taskId, "ポリシーステータスが block のため承認依頼できません。"));
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
    redirect(errorPath(taskId, "このタスクにはすでに保留中の承認があります。"));
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

  const modelPayload = latestModelEvent.payload_json as { output?: { summary?: string } } | null;
  const policyPayloadFull = latestPolicyEvent.payload_json as { status?: string } | null;
  const draftSummary =
    typeof modelPayload?.output?.summary === "string" ? modelPayload.output.summary : null;
  const policyStatus = typeof policyPayloadFull?.status === "string" ? policyPayloadFull.status : null;

  try {
    const slackMessage = await postApprovalRequestToSlack({
      supabase,
      orgId,
      approvalId: approval.id as string,
      taskId,
      taskTitle: task.title as string,
      draftSummary,
      policyStatus
    });

    if (slackMessage) {
      await appendTaskEvent({
        supabase,
        orgId,
        taskId,
        actorType: "system",
        actorId: null,
        eventType: "SLACK_APPROVAL_POSTED",
        payload: {
          channel_id: slackMessage.channel,
          slack_ts: slackMessage.ts
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slack承認投稿に失敗しました。";
    console.error(`[SLACK_APPROVAL_POST_FAILED] task_id=${taskId} approval_id=${approval.id as string} ${message}`);
  }

  revalidatePath(taskPath(taskId));
  revalidatePath("/app/tasks");
  revalidatePath("/app/approvals");
  redirect(okPath(taskId, "承認依頼を作成しました。"));
}

export async function generateDraft(formData: FormData) {
  const taskId = String(formData.get("task_id") ?? "").trim();
  if (!taskId) {
    redirect("/app/tasks?error=task_id+がありません");
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
    redirect(errorPath(taskId, `エージェント取得に失敗しました: ${agentError.message}`));
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
      output: result.output,
      coercions: result.metadata.coercions,
      raw_model_output: result.metadata.rawModelOutput
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なモデルエラーです。";
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
  redirect(okPath(taskId, "ドラフト生成とポリシーチェックを完了しました。"));
}

export async function executeDraftAction(formData: FormData) {
  const taskId = String(formData.get("task_id") ?? "").trim();
  if (!taskId) {
    redirect("/app/tasks?error=task_id+がありません");
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  try {
    const result = await executeTaskDraftActionShared({
      supabase,
      orgId,
      userId,
      taskId,
      source: "manual_action_runner"
    });
    if (result.status === "skipped") {
      redirect(errorPath(taskId, result.message));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "実行に失敗しました。";
    redirect(errorPath(taskId, message));
  }

  revalidatePath(taskPath(taskId));
  revalidatePath("/app/tasks");
  revalidatePath("/app/approvals");
  redirect(okPath(taskId, "メール送信アクションを実行しました。"));
}
