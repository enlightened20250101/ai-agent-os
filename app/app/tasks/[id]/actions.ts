"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { computeGoogleSendEmailIdempotencyKey } from "@/lib/actions/idempotency";
import { resolveGoogleRuntimeConfig } from "@/lib/connectors/runtime";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { sendEmailWithGmail } from "@/lib/google/gmail";
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

type ParsedProposedAction = {
  provider: "google";
  action_type: "send_email";
  to: string;
  subject: string;
  body_text: string;
};

function parseLatestDraftAction(payload: unknown): ParsedProposedAction | null {
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
  if (
    typeof action.to !== "string" ||
    typeof action.subject !== "string" ||
    typeof action.body_text !== "string"
  ) {
    return null;
  }
  return {
    provider: "google",
    action_type: "send_email",
    to: action.to,
    subject: action.subject,
    body_text: action.body_text
  };
}

function parsePolicyStatus(payload: unknown): "pass" | "warn" | "block" | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  if (p.status === "pass" || p.status === "warn" || p.status === "block") {
    return p.status;
  }
  return null;
}

function getAllowedDomains() {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function getEmailDomain(email: string) {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at >= email.length - 1) {
    return null;
  }
  return email.slice(at + 1).toLowerCase();
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "23505";
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
    const message = error instanceof Error ? error.message : "Slack approval post failed.";
    console.error(`[SLACK_APPROVAL_POST_FAILED] task_id=${taskId} approval_id=${approval.id as string} ${message}`);
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
      output: result.output,
      coercions: result.metadata.coercions,
      raw_model_output: result.metadata.rawModelOutput
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

export async function executeDraftAction(formData: FormData) {
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

  const { data: latestModelEvent, error: modelError } = await supabase
    .from("task_events")
    .select("id, payload_json")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .eq("event_type", "MODEL_INFERRED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (modelError) {
    redirect(errorPath(taskId, modelError.message));
  }
  if (!latestModelEvent) {
    redirect(errorPath(taskId, "No model draft found."));
  }

  const { data: latestPolicyEvent, error: policyError } = await supabase
    .from("task_events")
    .select("id, payload_json")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .eq("event_type", "POLICY_CHECKED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (policyError) {
    redirect(errorPath(taskId, policyError.message));
  }
  if (!latestPolicyEvent) {
    redirect(errorPath(taskId, "No policy result found."));
  }

  const action = parseLatestDraftAction(latestModelEvent.payload_json);
  if (!action) {
    redirect(errorPath(taskId, "No executable google/send_email draft action found."));
  }
  const policyStatus = parsePolicyStatus(latestPolicyEvent.payload_json);
  if (!policyStatus) {
    redirect(errorPath(taskId, "Policy status is invalid."));
  }

  const eligibilityReasons: string[] = [];
  if (task.status !== "approved") {
    eligibilityReasons.push("Task must be approved before execution.");
  }
  if (policyStatus === "block") {
    eligibilityReasons.push("Policy status is block.");
  }

  const allowedDomains = getAllowedDomains();
  const toDomain = getEmailDomain(action.to);
  if (allowedDomains.length > 0 && (!toDomain || !allowedDomains.includes(toDomain))) {
    eligibilityReasons.push(`Recipient domain ${toDomain ?? "(invalid)"} not allowed.`);
  }

  const googleCfg = await resolveGoogleRuntimeConfig({ supabase, orgId });
  const isE2EStubMode = process.env.E2E_MODE === "1";
  if (
    !isE2EStubMode &&
    (!googleCfg.clientId || !googleCfg.clientSecret || !googleCfg.refreshToken || !googleCfg.senderEmail)
  ) {
    eligibilityReasons.push("Google connector is not configured.");
  }

  if (eligibilityReasons.length > 0) {
    redirect(errorPath(taskId, eligibilityReasons.join(" ")));
  }

  const idempotencyKey = computeGoogleSendEmailIdempotencyKey({
    taskId,
    provider: "google",
    actionType: "send_email",
    to: action.to,
    subject: action.subject,
    bodyText: action.body_text
  });

  const { data: existingSuccess, error: existingSuccessError } = await supabase
    .from("actions")
    .select("id")
    .eq("org_id", orgId)
    .eq("idempotency_key", idempotencyKey)
    .eq("status", "success")
    .limit(1)
    .maybeSingle();
  if (existingSuccessError) {
    redirect(errorPath(taskId, existingSuccessError.message));
  }
  if (existingSuccess?.id) {
    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorType: "user",
      actorId: userId,
      eventType: "ACTION_SKIPPED",
      payload: {
        reason: "idempotency_already_success",
        idempotency_key: idempotencyKey,
        existing_action_id: existingSuccess.id
      }
    });
    revalidatePath(taskPath(taskId));
    redirect(errorPath(taskId, "Already executed successfully for this draft action."));
  }

  const { data: runningForTask, error: runningForTaskError } = await supabase
    .from("actions")
    .select("id")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .eq("status", "running")
    .limit(1)
    .maybeSingle();
  if (runningForTaskError) {
    redirect(errorPath(taskId, runningForTaskError.message));
  }
  if (runningForTask?.id) {
    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorType: "user",
      actorId: userId,
      eventType: "ACTION_SKIPPED",
      payload: {
        reason: "already_running",
        running_action_id: runningForTask.id
      }
    });
    revalidatePath(taskPath(taskId));
    redirect(errorPath(taskId, "Execution already in progress for this task."));
  }

  const { data: createdAction, error: createActionError } = await supabase
    .from("actions")
    .insert({
      org_id: orgId,
      task_id: taskId,
      provider: "google",
      action_type: "send_email",
      idempotency_key: idempotencyKey,
      request_json: {
        to: action.to,
        subject: action.subject,
        body_text: action.body_text
      },
      status: "queued",
      result_json: {}
    })
    .select("id")
    .single();

  if (createActionError) {
    if (isUniqueViolation(createActionError)) {
      const { data: existingAction, error: existingActionError } = await supabase
        .from("actions")
        .select("id, status")
        .eq("org_id", orgId)
        .eq("idempotency_key", idempotencyKey)
        .limit(1)
        .maybeSingle();

      if (existingActionError) {
        redirect(errorPath(taskId, existingActionError.message));
      }

      if (existingAction?.id) {
        const reason =
          existingAction.status === "success"
            ? "idempotency_already_success"
            : existingAction.status === "running"
              ? "already_running"
              : "idempotency_existing_action";
        await appendTaskEvent({
          supabase,
          orgId,
          taskId,
          actorType: "user",
          actorId: userId,
          eventType: "ACTION_SKIPPED",
          payload: {
            reason,
            idempotency_key: idempotencyKey,
            existing_action_id: existingAction.id,
            existing_status: existingAction.status
          }
        });
        revalidatePath(taskPath(taskId));
        redirect(
          errorPath(
            taskId,
            existingAction.status === "success"
              ? "Already executed successfully for this draft action."
              : "Execution is already queued or running for this draft action."
          )
        );
      }
    }
    redirect(errorPath(taskId, createActionError.message));
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId,
    actorType: "user",
    actorId: userId,
    eventType: "ACTION_QUEUED",
    payload: {
      action_id: createdAction.id,
      idempotency_key: idempotencyKey,
      provider: "google",
      action_type: "send_email",
      request: {
        to: action.to,
        subject: action.subject
      }
    }
  });

  const { error: runningError } = await supabase
    .from("actions")
    .update({ status: "running" })
    .eq("id", createdAction.id)
    .eq("org_id", orgId)
    .eq("status", "queued");
  if (runningError) {
    if (isUniqueViolation(runningError)) {
      await appendTaskEvent({
        supabase,
        orgId,
        taskId,
        actorType: "user",
        actorId: userId,
        eventType: "ACTION_SKIPPED",
        payload: {
          reason: "already_running",
          action_id: createdAction.id,
          idempotency_key: idempotencyKey
        }
      });
      await supabase
        .from("actions")
        .update({
          status: "failed",
          result_json: {
            error: "Skipped due to concurrent running action."
          }
        })
        .eq("id", createdAction.id)
        .eq("org_id", orgId);
      revalidatePath(taskPath(taskId));
      redirect(errorPath(taskId, "Execution already in progress for this task."));
    }
    redirect(errorPath(taskId, runningError.message));
  }

  try {
    const sendResult = await sendEmailWithGmail({
      clientId: googleCfg.clientId,
      clientSecret: googleCfg.clientSecret,
      refreshToken: googleCfg.refreshToken,
      senderEmail: googleCfg.senderEmail,
      to: action.to,
      subject: action.subject,
      bodyText: action.body_text
    });

    const { error: successUpdateError } = await supabase
      .from("actions")
      .update({
        status: "success",
        result_json: {
          gmail_message_id: sendResult.messageId,
          stubbed: sendResult.stubbed
        }
      })
      .eq("id", createdAction.id)
      .eq("org_id", orgId);
    if (successUpdateError) {
      redirect(errorPath(taskId, successUpdateError.message));
    }

    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorType: "system",
      actorId: null,
      eventType: "ACTION_EXECUTED",
      payload: {
        action_id: createdAction.id,
        idempotency_key: idempotencyKey,
        provider: "google",
        action_type: "send_email",
        gmail_message_id: sendResult.messageId,
        stubbed: sendResult.stubbed
      }
    });
  } catch (error) {
    const summary = error instanceof Error ? error.message.slice(0, 500) : "Unknown send error.";

    await supabase
      .from("actions")
      .update({
        status: "failed",
        result_json: {
          error: summary
        }
      })
      .eq("id", createdAction.id)
      .eq("org_id", orgId);

    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorType: "system",
      actorId: null,
      eventType: "ACTION_FAILED",
      payload: {
        action_id: createdAction.id,
        idempotency_key: idempotencyKey,
        provider: "google",
        action_type: "send_email",
        error: summary
      }
    });

    redirect(errorPath(taskId, `Execution failed: ${summary}`));
  }

  revalidatePath(taskPath(taskId));
  revalidatePath("/app/tasks");
  revalidatePath("/app/approvals");
}
