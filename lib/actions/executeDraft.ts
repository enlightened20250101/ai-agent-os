import type { SupabaseClient } from "@supabase/supabase-js";
import { computeGoogleSendEmailIdempotencyKey } from "@/lib/actions/idempotency";
import { syncCaseStageForTask } from "@/lib/cases/stageSync";
import { resolveGoogleRuntimeConfig } from "@/lib/connectors/runtime";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { sendEmailWithGmail } from "@/lib/google/gmail";
import { evaluateGovernance, incrementBudgetUsage } from "@/lib/governance/evaluate";
import {
  evaluateApprovalGuardrail,
  evaluateHourlyBudgetGuardrail
} from "@/lib/governance/guardrails";
import { recordTrustOutcome } from "@/lib/governance/trust";

type ParsedProposedAction = {
  provider: "google";
  action_type: "send_email";
  to: string;
  subject: string;
  body_text: string;
};

type ExecuteDraftActionParams = {
  supabase: SupabaseClient;
  orgId: string;
  userId: string;
  taskId: string;
  source: "manual_action_runner" | "chat_command";
};

export type ExecuteDraftActionResult = {
  status: "success" | "skipped";
  taskId: string;
  actionId: string | null;
  idempotencyKey: string | null;
  message: string;
  reason?: string;
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

export async function executeTaskDraftActionShared(params: ExecuteDraftActionParams): Promise<ExecuteDraftActionResult> {
  const { supabase, orgId, userId, taskId, source } = params;
  const trustSource = source === "chat_command" ? "manual_action_runner" : source;

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, status, agent_id")
    .eq("id", taskId)
    .eq("org_id", orgId)
    .single();
  if (taskError) {
    throw new Error(taskError.message);
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
    throw new Error(modelError.message);
  }
  if (!latestModelEvent) {
    throw new Error("モデルドラフトが見つかりません。");
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
    throw new Error(policyError.message);
  }
  if (!latestPolicyEvent) {
    throw new Error("ポリシー結果が見つかりません。");
  }

  const action = parseLatestDraftAction(latestModelEvent.payload_json);
  if (!action) {
    throw new Error("実行可能な google/send_email ドラフトが見つかりません。");
  }
  const policyStatus = parsePolicyStatus(latestPolicyEvent.payload_json);
  if (!policyStatus) {
    throw new Error("ポリシーステータスが不正です。");
  }

  const eligibilityReasons: string[] = [];
  if (policyStatus === "block") {
    eligibilityReasons.push("ポリシーステータスが block です。");
  }

  const allowedDomains = getAllowedDomains();
  const toDomain = getEmailDomain(action.to);
  if (allowedDomains.length > 0 && (!toDomain || !allowedDomains.includes(toDomain))) {
    eligibilityReasons.push(`宛先ドメイン ${toDomain ?? "(無効)"} は許可されていません。`);
  }

  const taskAgentId = (task as { agent_id?: string | null }).agent_id ?? null;
  let agentRoleKey: string | null = null;
  if (taskAgentId) {
    const { data: agentRes } = await supabase
      .from("agents")
      .select("role_key")
      .eq("id", taskAgentId)
      .eq("org_id", orgId)
      .maybeSingle();
    agentRoleKey = (agentRes?.role_key as string | undefined) ?? null;
  }

  const googleCfg = await resolveGoogleRuntimeConfig({ supabase, orgId });
  const isE2EStubMode = process.env.E2E_MODE === "1";
  if (
    !isE2EStubMode &&
    (!googleCfg.clientId || !googleCfg.clientSecret || !googleCfg.refreshToken || !googleCfg.senderEmail)
  ) {
    eligibilityReasons.push("Googleコネクタが未設定です。");
  }

  const governance = await evaluateGovernance({
    supabase,
    orgId,
    taskId,
    provider: "google",
    actionType: "send_email",
    to: action.to,
    subject: action.subject,
    bodyText: action.body_text,
    policyStatus,
    agentRoleKey
  });

  const canAutoExecute = governance.decision === "allow_auto_execute";
  const approvalGuardrail = await evaluateApprovalGuardrail({
    supabase,
    orgId,
    taskId,
    riskScore: governance.riskScore
  });
  if (approvalGuardrail.distinctApproverCount < approvalGuardrail.requiredApprovals) {
    eligibilityReasons.push(
      `承認者数が不足しています（必要=${approvalGuardrail.requiredApprovals}, 現在=${approvalGuardrail.distinctApproverCount}）。`
    );
  }
  const hourlyGuardrail = await evaluateHourlyBudgetGuardrail({
    supabase,
    orgId,
    provider: "google",
    actionType: "send_email"
  });
  if (hourlyGuardrail.remainingLastHour <= 0) {
    eligibilityReasons.push(
      `1時間あたり実行上限に達しています（limit=${hourlyGuardrail.hourlyLimit}）。`
    );
  }
  if (task.status !== "approved" && !canAutoExecute) {
    eligibilityReasons.push("実行前にタスクが approved である必要があります。");
  }
  if (governance.decision === "block") {
    eligibilityReasons.push(`ガバナンス評価で block: ${governance.reasons.join(" ") || "リスク閾値違反"}`);
  }

  if (eligibilityReasons.length > 0) {
    throw new Error(eligibilityReasons.join(" "));
  }

  if (task.status !== "approved" && canAutoExecute) {
    const { error: taskAutoApproveError } = await supabase
      .from("tasks")
      .update({ status: "approved" })
      .eq("id", taskId)
      .eq("org_id", orgId);
    if (taskAutoApproveError) {
      throw new Error(taskAutoApproveError.message);
    }

    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorType: "system",
      actorId: null,
      eventType: "APPROVAL_BYPASSED",
      payload: {
        reason: "governance_allow_auto_execute",
        governance
      }
    });
    await appendTaskEvent({
      supabase,
      orgId,
      taskId,
      actorType: "system",
      actorId: null,
      eventType: "TASK_UPDATED",
      payload: {
        changed_fields: {
          status: {
            from: task.status,
            to: "approved"
          }
        },
        source: "autonomy_auto_approval"
      }
    });
    await syncCaseStageForTask({
      supabase,
      orgId,
      taskId,
      actorUserId: null,
      source: "autonomy_auto_approval"
    });
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
    throw new Error(existingSuccessError.message);
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
        existing_action_id: existingSuccess.id,
        source
      }
    });
    return {
      status: "skipped",
      taskId,
      actionId: existingSuccess.id as string,
      idempotencyKey,
      reason: "idempotency_already_success",
      message: "このドラフトアクションはすでに実行済みです。"
    };
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
    throw new Error(runningForTaskError.message);
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
        running_action_id: runningForTask.id,
        source
      }
    });
    return {
      status: "skipped",
      taskId,
      actionId: runningForTask.id as string,
      idempotencyKey,
      reason: "already_running",
      message: "このタスクはすでに実行中です。"
    };
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
        throw new Error(existingActionError.message);
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
            existing_status: existingAction.status,
            source
          }
        });
        return {
          status: "skipped",
          taskId,
          actionId: existingAction.id as string,
          idempotencyKey,
          reason,
          message:
            existingAction.status === "success"
              ? "このドラフトアクションはすでに実行済みです。"
              : "このドラフトアクションはすでにキュー済みまたは実行中です。"
        };
      }
    }
    throw new Error(createActionError.message);
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
      },
      source
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
          idempotency_key: idempotencyKey,
          source
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
      return {
        status: "skipped",
        taskId,
        actionId: createdAction.id as string,
        idempotencyKey,
        reason: "already_running",
        message: "このタスクはすでに実行中です。"
      };
    }
    throw new Error(runningError.message);
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
      throw new Error(successUpdateError.message);
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
        stubbed: sendResult.stubbed,
        source
      }
    });

    try {
      await recordTrustOutcome({
        supabase,
        orgId,
        provider: "google",
        actionType: "send_email",
        outcome: "success",
        agentRoleKey,
        taskId,
        actionId: createdAction.id as string,
        source: trustSource
      });
    } catch (trustError) {
      const message = trustError instanceof Error ? trustError.message : "unknown_trust_error";
      console.error(`[TRUST_UPDATE_FAILED] task_id=${taskId} action_id=${createdAction.id as string} ${message}`);
    }

    await incrementBudgetUsage({
      supabase,
      orgId,
      provider: "google",
      actionType: "send_email"
    });

    return {
      status: "success",
      taskId,
      actionId: createdAction.id as string,
      idempotencyKey,
      message: `メールを実行しました。message_id=${sendResult.messageId}`
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message.slice(0, 500) : "不明な送信エラーです。";

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
        error: summary,
        source
      }
    });

    try {
      await recordTrustOutcome({
        supabase,
        orgId,
        provider: "google",
        actionType: "send_email",
        outcome: "failed",
        agentRoleKey,
        taskId,
        actionId: createdAction.id as string,
        source: trustSource
      });
    } catch (trustError) {
      const message = trustError instanceof Error ? trustError.message : "unknown_trust_error";
      console.error(`[TRUST_UPDATE_FAILED] task_id=${taskId} action_id=${createdAction.id as string} ${message}`);
    }

    throw new Error(`実行に失敗しました: ${summary}`);
  }
}
