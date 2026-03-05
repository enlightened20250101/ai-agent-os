import type { SupabaseClient } from "@supabase/supabase-js";
import { computeGoogleSendEmailIdempotencyKey } from "@/lib/actions/idempotency";
import { resolveGoogleRuntimeConfig } from "@/lib/connectors/runtime";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { sendEmailWithGmail } from "@/lib/google/gmail";
import { evaluateGovernance, incrementBudgetUsage } from "@/lib/governance/evaluate";
import { recordTrustOutcome } from "@/lib/governance/trust";

type StepDef = {
  key: string;
  title: string;
  type?: string;
  requires_approval?: boolean;
};

type RunningStepRow = {
  id: string;
  step_key: string;
  step_index: number;
  step_type: string;
  started_at: string | null;
};

type StartWorkflowRunArgs = {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
  templateId: string;
  actorId: string;
};

type AdvanceWorkflowRunArgs = {
  supabase: SupabaseClient;
  orgId: string;
  workflowRunId: string;
  actorId: string;
};

type RetryWorkflowRunArgs = {
  supabase: SupabaseClient;
  orgId: string;
  workflowRunId: string;
  actorId: string;
};

type TickWorkflowRunsArgs = {
  supabase: SupabaseClient;
  orgId: string;
  actorId: string;
  limit?: number;
};

type ParsedProposedAction = {
  provider: "google";
  action_type: "send_email";
  to: string;
  subject: string;
  body_text: string;
};

function parseSteps(definitionJson: unknown): StepDef[] {
  if (typeof definitionJson !== "object" || definitionJson === null) {
    return [];
  }
  const def = definitionJson as Record<string, unknown>;
  if (!Array.isArray(def.steps)) {
    return [];
  }

  return def.steps
    .map((row, idx) => {
      if (typeof row !== "object" || row === null) return null;
      const item = row as Record<string, unknown>;
      const keyRaw = typeof item.key === "string" ? item.key.trim() : "";
      const key = keyRaw || `step_${idx + 1}`;
      const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : key;
      return {
        key,
        title,
        type: typeof item.type === "string" && item.type.trim() ? item.type.trim() : "task_event",
        requires_approval: item.requires_approval === true
      } as StepDef;
    })
    .filter((v): v is StepDef => v !== null);
}

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

async function loadWorkflowRun(args: {
  supabase: SupabaseClient;
  orgId: string;
  workflowRunId: string;
}) {
  const { data: run, error: runError } = await args.supabase
    .from("workflow_runs")
    .select("id, task_id, status")
    .eq("id", args.workflowRunId)
    .eq("org_id", args.orgId)
    .single();

  if (runError || !run) {
    throw new Error(`workflow run 取得に失敗しました: ${runError?.message ?? "run_not_found"}`);
  }

  return {
    id: run.id as string,
    taskId: run.task_id as string,
    status: run.status as string
  };
}

async function getRunningStep(args: {
  supabase: SupabaseClient;
  orgId: string;
  workflowRunId: string;
}): Promise<RunningStepRow | null> {
  const { data: row, error } = await args.supabase
    .from("workflow_steps")
    .select("id, step_key, step_index, step_type, started_at")
    .eq("org_id", args.orgId)
    .eq("workflow_run_id", args.workflowRunId)
    .eq("status", "running")
    .order("step_index", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`現在step取得に失敗しました: ${error.message}`);
  }
  if (!row) {
    return null;
  }
  return {
    id: row.id as string,
    step_key: row.step_key as string,
    step_index: row.step_index as number,
    step_type: row.step_type as string,
    started_at: (row.started_at as string | null) ?? null
  };
}

function getWorkflowStepTimeoutSeconds() {
  const raw = Number.parseInt(process.env.WORKFLOW_STEP_TIMEOUT_SECONDS ?? "900", 10);
  if (Number.isNaN(raw)) return 900;
  return Math.max(60, Math.min(24 * 60 * 60, raw));
}

async function moveQueuedStepToRunning(args: {
  supabase: SupabaseClient;
  orgId: string;
  workflowRunId: string;
}) {
  const { data: nextStep, error: nextStepError } = await args.supabase
    .from("workflow_steps")
    .select("id, step_key, step_index, step_type")
    .eq("org_id", args.orgId)
    .eq("workflow_run_id", args.workflowRunId)
    .eq("status", "queued")
    .order("step_index", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (nextStepError) {
    throw new Error(`次step取得に失敗しました: ${nextStepError.message}`);
  }
  if (!nextStep) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const { error: startStepError } = await args.supabase
    .from("workflow_steps")
    .update({
      status: "running",
      started_at: nowIso
    })
    .eq("id", nextStep.id)
    .eq("org_id", args.orgId)
    .eq("status", "queued");
  if (startStepError) {
    throw new Error(`次step開始に失敗しました: ${startStepError.message}`);
  }

  const { error: updateRunError } = await args.supabase
    .from("workflow_runs")
    .update({
      current_step_key: nextStep.step_key
    })
    .eq("id", args.workflowRunId)
    .eq("org_id", args.orgId);
  if (updateRunError) {
    throw new Error(`workflow run 更新に失敗しました: ${updateRunError.message}`);
  }

  return {
    id: nextStep.id as string,
    step_key: nextStep.step_key as string,
    step_index: nextStep.step_index as number,
    step_type: nextStep.step_type as string
  } as RunningStepRow;
}

async function completeRunningStep(args: {
  supabase: SupabaseClient;
  orgId: string;
  stepId: string;
  actorId: string;
  output?: Record<string, unknown>;
}) {
  const nowIso = new Date().toISOString();
  const { error } = await args.supabase
    .from("workflow_steps")
    .update({
      status: "completed",
      finished_at: nowIso,
      output_json: {
        completed_by: args.actorId,
        completed_at: nowIso,
        ...(args.output ?? {})
      }
    })
    .eq("id", args.stepId)
    .eq("org_id", args.orgId);

  if (error) {
    throw new Error(`step完了更新に失敗しました: ${error.message}`);
  }
}

async function failRunningStepAndRun(args: {
  supabase: SupabaseClient;
  orgId: string;
  workflowRunId: string;
  stepId: string;
  taskId: string;
  actorId: string;
  stepKey: string;
  stepIndex: number;
  errorMessage: string;
}) {
  const nowIso = new Date().toISOString();
  const { error: stepFailError } = await args.supabase
    .from("workflow_steps")
    .update({
      status: "failed",
      finished_at: nowIso,
      error_json: {
        message: args.errorMessage.slice(0, 1000),
        failed_at: nowIso
      }
    })
    .eq("id", args.stepId)
    .eq("org_id", args.orgId);
  if (stepFailError) {
    throw new Error(`step失敗更新に失敗しました: ${stepFailError.message}`);
  }

  const { error: runFailError } = await args.supabase
    .from("workflow_runs")
    .update({
      status: "failed",
      finished_at: nowIso,
      current_step_key: args.stepKey
    })
    .eq("id", args.workflowRunId)
    .eq("org_id", args.orgId);
  if (runFailError) {
    throw new Error(`workflow run失敗更新に失敗しました: ${runFailError.message}`);
  }

  await appendTaskEvent({
    supabase: args.supabase,
    orgId: args.orgId,
    taskId: args.taskId,
    actorType: "system",
    actorId: args.actorId,
    eventType: "WORKFLOW_FAILED",
    payload: {
      workflow_run_id: args.workflowRunId,
      step_key: args.stepKey,
      step_index: args.stepIndex,
      error: args.errorMessage.slice(0, 500)
    }
  });
}

async function executeGoogleSendEmailForTask(args: {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
  actorId: string;
}) {
  const { data: task, error: taskError } = await args.supabase
    .from("tasks")
    .select("id, status, agent_id")
    .eq("id", args.taskId)
    .eq("org_id", args.orgId)
    .single();
  if (taskError) {
    throw new Error(taskError.message);
  }

  const { data: latestModelEvent, error: modelError } = await args.supabase
    .from("task_events")
    .select("id, payload_json")
    .eq("org_id", args.orgId)
    .eq("task_id", args.taskId)
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

  const { data: latestPolicyEvent, error: policyError } = await args.supabase
    .from("task_events")
    .select("id, payload_json")
    .eq("org_id", args.orgId)
    .eq("task_id", args.taskId)
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
  if (policyStatus === "block") {
    throw new Error("ポリシーステータスが block です。");
  }

  const allowedDomains = getAllowedDomains();
  const toDomain = getEmailDomain(action.to);
  if (allowedDomains.length > 0 && (!toDomain || !allowedDomains.includes(toDomain))) {
    throw new Error(`宛先ドメイン ${toDomain ?? "(無効)"} は許可されていません。`);
  }

  const taskAgentId = (task as { agent_id?: string | null }).agent_id ?? null;
  let agentRoleKey: string | null = null;
  if (taskAgentId) {
    const { data: agentRes } = await args.supabase
      .from("agents")
      .select("role_key")
      .eq("id", taskAgentId)
      .eq("org_id", args.orgId)
      .maybeSingle();
    agentRoleKey = (agentRes?.role_key as string | undefined) ?? null;
  }

  const governance = await evaluateGovernance({
    supabase: args.supabase,
    orgId: args.orgId,
    taskId: args.taskId,
    provider: "google",
    actionType: "send_email",
    to: action.to,
    subject: action.subject,
    bodyText: action.body_text,
    policyStatus,
    agentRoleKey
  });

  if (governance.decision === "block") {
    throw new Error(`ガバナンス判定が block です。${governance.reasons.join(" ")}`);
  }

  if (task.status !== "approved" && governance.decision !== "allow_auto_execute") {
    throw new Error("タスクステータスが approved ではありません。自動実行条件を満たしていません。");
  }

  if (task.status !== "approved" && governance.decision === "allow_auto_execute") {
    const { error: taskAutoApproveError } = await args.supabase
      .from("tasks")
      .update({ status: "approved" })
      .eq("id", args.taskId)
      .eq("org_id", args.orgId);
    if (taskAutoApproveError) {
      throw new Error(taskAutoApproveError.message);
    }

    await appendTaskEvent({
      supabase: args.supabase,
      orgId: args.orgId,
      taskId: args.taskId,
      actorType: "system",
      actorId: null,
      eventType: "APPROVAL_BYPASSED",
      payload: {
        reason: "workflow_governance_allow_auto_execute",
        governance
      }
    });

    await appendTaskEvent({
      supabase: args.supabase,
      orgId: args.orgId,
      taskId: args.taskId,
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
        source: "workflow_autonomy_auto_approval"
      }
    });
  }

  const googleCfg = await resolveGoogleRuntimeConfig({ supabase: args.supabase, orgId: args.orgId });
  const isE2EStubMode = process.env.E2E_MODE === "1";
  if (
    !isE2EStubMode &&
    (!googleCfg.clientId || !googleCfg.clientSecret || !googleCfg.refreshToken || !googleCfg.senderEmail)
  ) {
    throw new Error("Googleコネクタが未設定です。");
  }

  const idempotencyKey = computeGoogleSendEmailIdempotencyKey({
    taskId: args.taskId,
    provider: "google",
    actionType: "send_email",
    to: action.to,
    subject: action.subject,
    bodyText: action.body_text
  });

  const { data: existingSuccess, error: existingSuccessError } = await args.supabase
    .from("actions")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("idempotency_key", idempotencyKey)
    .eq("status", "success")
    .limit(1)
    .maybeSingle();
  if (existingSuccessError) {
    throw new Error(existingSuccessError.message);
  }
  if (existingSuccess?.id) {
    await appendTaskEvent({
      supabase: args.supabase,
      orgId: args.orgId,
      taskId: args.taskId,
      actorType: "system",
      actorId: null,
      eventType: "ACTION_SKIPPED",
      payload: {
        reason: "idempotency_already_success",
        idempotency_key: idempotencyKey,
        existing_action_id: existingSuccess.id,
        source: "workflow"
      }
    });

    return {
      status: "skipped" as const,
      reason: "idempotency_already_success"
    };
  }

  const { data: runningForTask, error: runningForTaskError } = await args.supabase
    .from("actions")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("task_id", args.taskId)
    .eq("status", "running")
    .limit(1)
    .maybeSingle();
  if (runningForTaskError) {
    throw new Error(runningForTaskError.message);
  }
  if (runningForTask?.id) {
    await appendTaskEvent({
      supabase: args.supabase,
      orgId: args.orgId,
      taskId: args.taskId,
      actorType: "system",
      actorId: null,
      eventType: "ACTION_SKIPPED",
      payload: {
        reason: "already_running",
        running_action_id: runningForTask.id,
        source: "workflow"
      }
    });

    return {
      status: "skipped" as const,
      reason: "already_running"
    };
  }

  const { data: createdAction, error: createActionError } = await args.supabase
    .from("actions")
    .insert({
      org_id: args.orgId,
      task_id: args.taskId,
      provider: "google",
      action_type: "send_email",
      idempotency_key: idempotencyKey,
      request_json: {
        to: action.to,
        subject: action.subject,
        body_text: action.body_text,
        source: "workflow"
      },
      status: "queued",
      result_json: {}
    })
    .select("id")
    .single();

  if (createActionError) {
    if (isUniqueViolation(createActionError)) {
      const { data: existingAction, error: existingActionError } = await args.supabase
        .from("actions")
        .select("id, status")
        .eq("org_id", args.orgId)
        .eq("idempotency_key", idempotencyKey)
        .limit(1)
        .maybeSingle();

      if (existingActionError) {
        throw new Error(existingActionError.message);
      }

      await appendTaskEvent({
        supabase: args.supabase,
        orgId: args.orgId,
        taskId: args.taskId,
        actorType: "system",
        actorId: null,
        eventType: "ACTION_SKIPPED",
        payload: {
          reason: "idempotency_existing_action",
          idempotency_key: idempotencyKey,
          existing_action_id: existingAction?.id ?? null,
          existing_status: existingAction?.status ?? null,
          source: "workflow"
        }
      });

      return {
        status: "skipped" as const,
        reason: "idempotency_existing_action"
      };
    }
    throw new Error(createActionError.message);
  }

  await appendTaskEvent({
    supabase: args.supabase,
    orgId: args.orgId,
    taskId: args.taskId,
    actorType: "system",
    actorId: null,
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
      source: "workflow"
    }
  });

  const { error: runningError } = await args.supabase
    .from("actions")
    .update({ status: "running" })
    .eq("id", createdAction.id)
    .eq("org_id", args.orgId)
    .eq("status", "queued");
  if (runningError) {
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

    const { error: successUpdateError } = await args.supabase
      .from("actions")
      .update({
        status: "success",
        result_json: {
          gmail_message_id: sendResult.messageId,
          stubbed: sendResult.stubbed,
          source: "workflow"
        }
      })
      .eq("id", createdAction.id)
      .eq("org_id", args.orgId);
    if (successUpdateError) {
      throw new Error(successUpdateError.message);
    }

    await appendTaskEvent({
      supabase: args.supabase,
      orgId: args.orgId,
      taskId: args.taskId,
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
        source: "workflow"
      }
    });
    try {
      await recordTrustOutcome({
        supabase: args.supabase,
        orgId: args.orgId,
        provider: "google",
        actionType: "send_email",
        outcome: "success",
        agentRoleKey,
        taskId: args.taskId,
        actionId: createdAction.id as string,
        source: "workflow_step"
      });
    } catch (trustError) {
      const message = trustError instanceof Error ? trustError.message : "unknown_trust_error";
      console.error(
        `[TRUST_UPDATE_FAILED][workflow] task_id=${args.taskId} action_id=${createdAction.id as string} ${message}`
      );
    }

    await incrementBudgetUsage({
      supabase: args.supabase,
      orgId: args.orgId,
      provider: "google",
      actionType: "send_email"
    });

    return {
      status: "success" as const,
      actionId: createdAction.id as string,
      idempotencyKey,
      messageId: sendResult.messageId,
      stubbed: sendResult.stubbed
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message.slice(0, 500) : "不明な送信エラーです。";

    await args.supabase
      .from("actions")
      .update({
        status: "failed",
        result_json: {
          error: summary,
          source: "workflow"
        }
      })
      .eq("id", createdAction.id)
      .eq("org_id", args.orgId);

    await appendTaskEvent({
      supabase: args.supabase,
      orgId: args.orgId,
      taskId: args.taskId,
      actorType: "system",
      actorId: null,
      eventType: "ACTION_FAILED",
      payload: {
        action_id: createdAction.id,
        idempotency_key: idempotencyKey,
        provider: "google",
        action_type: "send_email",
        error: summary,
        source: "workflow"
      }
    });
    try {
      await recordTrustOutcome({
        supabase: args.supabase,
        orgId: args.orgId,
        provider: "google",
        actionType: "send_email",
        outcome: "failed",
        agentRoleKey,
        taskId: args.taskId,
        actionId: createdAction.id as string,
        source: "workflow_step"
      });
    } catch (trustError) {
      const message = trustError instanceof Error ? trustError.message : "unknown_trust_error";
      console.error(
        `[TRUST_UPDATE_FAILED][workflow] task_id=${args.taskId} action_id=${createdAction.id as string} ${message}`
      );
    }

    throw new Error(`workflow action実行に失敗: ${summary}`);
  }
}

async function finishWorkflowRunIfNoQueuedStep(args: {
  supabase: SupabaseClient;
  orgId: string;
  workflowRunId: string;
  taskId: string;
  actorId: string;
}) {
  const { data: queuedStep, error: queuedError } = await args.supabase
    .from("workflow_steps")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("workflow_run_id", args.workflowRunId)
    .eq("status", "queued")
    .limit(1)
    .maybeSingle();

  if (queuedError) {
    throw new Error(`queued step確認に失敗しました: ${queuedError.message}`);
  }

  if (queuedStep?.id) {
    return false;
  }

  const nowIso = new Date().toISOString();
  const { error: finishRunError } = await args.supabase
    .from("workflow_runs")
    .update({
      status: "completed",
      finished_at: nowIso,
      current_step_key: null
    })
    .eq("id", args.workflowRunId)
    .eq("org_id", args.orgId);
  if (finishRunError) {
    throw new Error(`workflow run 完了更新に失敗しました: ${finishRunError.message}`);
  }

  await appendTaskEvent({
    supabase: args.supabase,
    orgId: args.orgId,
    taskId: args.taskId,
    actorType: "user",
    actorId: args.actorId,
    eventType: "WORKFLOW_COMPLETED",
    payload: {
      workflow_run_id: args.workflowRunId
    }
  });

  return true;
}

async function runAutomatableSteps(args: {
  supabase: SupabaseClient;
  orgId: string;
  workflowRunId: string;
  taskId: string;
  actorId: string;
}) {
  let guard = 0;
  while (guard < 20) {
    guard += 1;

    const runningStep = await getRunningStep({
      supabase: args.supabase,
      orgId: args.orgId,
      workflowRunId: args.workflowRunId
    });

    if (!runningStep) {
      return;
    }

    if (runningStep.step_type !== "execute_google_send_email") {
      return;
    }

    try {
      const result = await executeGoogleSendEmailForTask({
        supabase: args.supabase,
        orgId: args.orgId,
        taskId: args.taskId,
        actorId: args.actorId
      });

      await completeRunningStep({
        supabase: args.supabase,
        orgId: args.orgId,
        stepId: runningStep.id,
        actorId: args.actorId,
        output: {
          execution: result
        }
      });

      await appendTaskEvent({
        supabase: args.supabase,
        orgId: args.orgId,
        taskId: args.taskId,
        actorType: "system",
        actorId: args.actorId,
        eventType: "WORKFLOW_STEP_COMPLETED",
        payload: {
          workflow_run_id: args.workflowRunId,
          step_key: runningStep.step_key,
          step_index: runningStep.step_index,
          step_type: runningStep.step_type,
          execution: result
        }
      });

      const next = await moveQueuedStepToRunning({
        supabase: args.supabase,
        orgId: args.orgId,
        workflowRunId: args.workflowRunId
      });

      if (!next) {
        await finishWorkflowRunIfNoQueuedStep({
          supabase: args.supabase,
          orgId: args.orgId,
          workflowRunId: args.workflowRunId,
          taskId: args.taskId,
          actorId: args.actorId
        });
        return;
      }

      await appendTaskEvent({
        supabase: args.supabase,
        orgId: args.orgId,
        taskId: args.taskId,
        actorType: "system",
        actorId: args.actorId,
        eventType: "WORKFLOW_STEP_STARTED",
        payload: {
          workflow_run_id: args.workflowRunId,
          step_key: next.step_key,
          step_index: next.step_index,
          step_type: next.step_type
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow step execution failed";
      await failRunningStepAndRun({
        supabase: args.supabase,
        orgId: args.orgId,
        workflowRunId: args.workflowRunId,
        stepId: runningStep.id,
        taskId: args.taskId,
        actorId: args.actorId,
        stepKey: runningStep.step_key,
        stepIndex: runningStep.step_index,
        errorMessage: message
      });
      throw new Error(message);
    }
  }

  throw new Error("workflow automatable step loop exceeded safety guard.");
}

export async function startWorkflowRun({
  supabase,
  orgId,
  taskId,
  templateId,
  actorId
}: StartWorkflowRunArgs) {
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id")
    .eq("id", taskId)
    .eq("org_id", orgId)
    .single();
  if (taskError || !task) {
    throw new Error(`タスク取得に失敗しました: ${taskError?.message ?? "task_not_found"}`);
  }

  const { data: template, error: templateError } = await supabase
    .from("workflow_templates")
    .select("id, name, definition_json")
    .eq("id", templateId)
    .eq("org_id", orgId)
    .single();
  if (templateError || !template) {
    throw new Error(`テンプレート取得に失敗しました: ${templateError?.message ?? "template_not_found"}`);
  }

  const steps = parseSteps(template.definition_json);
  const finalSteps =
    steps.length > 0
      ? steps
      : [{ key: "default_step", title: "Default step", type: "task_event", requires_approval: false }];
  const firstStep = finalSteps[0];

  const { data: workflowRun, error: runError } = await supabase
    .from("workflow_runs")
    .insert({
      org_id: orgId,
      task_id: taskId,
      template_id: templateId,
      status: "running",
      current_step_key: firstStep.key
    })
    .select("id")
    .single();
  if (runError) {
    throw new Error(`workflow run 作成に失敗しました: ${runError.message}`);
  }

  const runId = workflowRun.id as string;

  const stepRows = finalSteps.map((step, idx) => ({
    org_id: orgId,
    workflow_run_id: runId,
    step_key: step.key,
    step_index: idx,
    step_type: step.type ?? "task_event",
    status: idx === 0 ? "running" : "queued",
    input_json: {
      title: step.title,
      requires_approval: step.requires_approval === true
    },
    started_at: idx === 0 ? new Date().toISOString() : null
  }));

  const { error: stepsError } = await supabase.from("workflow_steps").insert(stepRows);
  if (stepsError) {
    throw new Error(`workflow step 作成に失敗しました: ${stepsError.message}`);
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId,
    actorType: "user",
    actorId,
    eventType: "WORKFLOW_STARTED",
    payload: {
      workflow_run_id: runId,
      template_id: templateId,
      template_name: template.name,
      total_steps: finalSteps.length
    }
  });

  await appendTaskEvent({
    supabase,
    orgId,
    taskId,
    actorType: "user",
    actorId,
    eventType: "WORKFLOW_STEP_STARTED",
    payload: {
      workflow_run_id: runId,
      step_key: firstStep.key,
      step_index: 0,
      step_type: firstStep.type ?? "task_event",
      total_steps: finalSteps.length
    }
  });

  await runAutomatableSteps({
    supabase,
    orgId,
    workflowRunId: runId,
    taskId,
    actorId
  });

  return { workflowRunId: runId };
}

export async function advanceWorkflowRun({
  supabase,
  orgId,
  workflowRunId,
  actorId
}: AdvanceWorkflowRunArgs) {
  const run = await loadWorkflowRun({
    supabase,
    orgId,
    workflowRunId
  });

  if (run.status !== "running") {
    return { workflowRunId, status: run.status as string };
  }

  const currentStep = await getRunningStep({
    supabase,
    orgId,
    workflowRunId
  });

  if (!currentStep) {
    throw new Error("running step が見つかりません。");
  }

  await completeRunningStep({
    supabase,
    orgId,
    stepId: currentStep.id,
    actorId
  });

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: run.taskId,
    actorType: "user",
    actorId,
    eventType: "WORKFLOW_STEP_COMPLETED",
    payload: {
      workflow_run_id: workflowRunId,
      step_key: currentStep.step_key,
      step_index: currentStep.step_index,
      step_type: currentStep.step_type
    }
  });

  const nextStep = await moveQueuedStepToRunning({
    supabase,
    orgId,
    workflowRunId
  });

  if (!nextStep) {
    await finishWorkflowRunIfNoQueuedStep({
      supabase,
      orgId,
      workflowRunId,
      taskId: run.taskId,
      actorId
    });

    return { workflowRunId, status: "completed" as const };
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: run.taskId,
    actorType: "user",
    actorId,
    eventType: "WORKFLOW_STEP_STARTED",
    payload: {
      workflow_run_id: workflowRunId,
      step_key: nextStep.step_key,
      step_index: nextStep.step_index,
      step_type: nextStep.step_type
    }
  });

  await runAutomatableSteps({
    supabase,
    orgId,
    workflowRunId,
    taskId: run.taskId,
    actorId
  });

  const refreshedRun = await loadWorkflowRun({
    supabase,
    orgId,
    workflowRunId
  });

  return { workflowRunId, status: refreshedRun.status as "running" | "completed" | "failed" };
}

export async function retryFailedWorkflowRun({
  supabase,
  orgId,
  workflowRunId,
  actorId
}: RetryWorkflowRunArgs) {
  const run = await loadWorkflowRun({
    supabase,
    orgId,
    workflowRunId
  });

  if (run.status !== "failed") {
    throw new Error("failed 状態の workflow run のみ再試行できます。");
  }

  const { data: failedStep, error: failedStepError } = await supabase
    .from("workflow_steps")
    .select("id, step_key, step_index, step_type, retry_count")
    .eq("org_id", orgId)
    .eq("workflow_run_id", workflowRunId)
    .eq("status", "failed")
    .order("step_index", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (failedStepError) {
    throw new Error(`failed step 取得に失敗しました: ${failedStepError.message}`);
  }
  if (!failedStep) {
    throw new Error("再試行対象の failed step が見つかりません。");
  }

  const nowIso = new Date().toISOString();
  const { error: retryStepError } = await supabase
    .from("workflow_steps")
    .update({
      status: "running",
      started_at: nowIso,
      finished_at: null,
      error_json: {},
      output_json: {},
      retry_count: Number(failedStep.retry_count ?? 0) + 1
    })
    .eq("id", failedStep.id)
    .eq("org_id", orgId);

  if (retryStepError) {
    throw new Error(`failed step 再試行更新に失敗しました: ${retryStepError.message}`);
  }

  const { error: retryRunError } = await supabase
    .from("workflow_runs")
    .update({
      status: "running",
      finished_at: null,
      current_step_key: failedStep.step_key
    })
    .eq("id", workflowRunId)
    .eq("org_id", orgId);

  if (retryRunError) {
    throw new Error(`workflow run 再試行更新に失敗しました: ${retryRunError.message}`);
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: run.taskId,
    actorType: "user",
    actorId,
    eventType: "WORKFLOW_RETRIED",
    payload: {
      workflow_run_id: workflowRunId,
      step_key: failedStep.step_key,
      step_index: failedStep.step_index,
      step_type: failedStep.step_type
    }
  });

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: run.taskId,
    actorType: "user",
    actorId,
    eventType: "WORKFLOW_STEP_STARTED",
    payload: {
      workflow_run_id: workflowRunId,
      step_key: failedStep.step_key,
      step_index: failedStep.step_index,
      step_type: failedStep.step_type,
      retry: true
    }
  });

  await runAutomatableSteps({
    supabase,
    orgId,
    workflowRunId,
    taskId: run.taskId,
    actorId
  });

  const refreshedRun = await loadWorkflowRun({
    supabase,
    orgId,
    workflowRunId
  });

  return { workflowRunId, status: refreshedRun.status as "running" | "completed" | "failed" };
}

export async function tickWorkflowRuns({
  supabase,
  orgId,
  actorId,
  limit = 10
}: TickWorkflowRunsArgs) {
  const perTick = Math.max(1, Math.min(100, limit));
  const { data: runs, error: runsError } = await supabase
    .from("workflow_runs")
    .select("id, task_id, current_step_key")
    .eq("org_id", orgId)
    .eq("status", "running")
    .order("started_at", { ascending: true })
    .limit(perTick);

  if (runsError) {
    throw new Error(`workflow tick runs load failed: ${runsError.message}`);
  }

  const resultRows: Array<{ workflow_run_id: string; status: string; error?: string }> = [];
  let completed = 0;
  let stillRunning = 0;
  let failed = 0;
  const stepTimeoutSeconds = getWorkflowStepTimeoutSeconds();
  const nowMs = Date.now();

  for (const row of runs ?? []) {
    const workflowRunId = row.id as string;
    const taskId = row.task_id as string;
    try {
      const runningStep = await getRunningStep({
        supabase,
        orgId,
        workflowRunId
      });
      if (runningStep?.started_at) {
        const startedAtMs = Date.parse(runningStep.started_at);
        if (Number.isFinite(startedAtMs)) {
          const elapsedSeconds = Math.floor((nowMs - startedAtMs) / 1000);
          if (elapsedSeconds > stepTimeoutSeconds) {
            const timeoutMessage = `workflow step timeout exceeded (${elapsedSeconds}s > ${stepTimeoutSeconds}s)`;
            await failRunningStepAndRun({
              supabase,
              orgId,
              workflowRunId,
              stepId: runningStep.id,
              taskId,
              actorId,
              stepKey: runningStep.step_key,
              stepIndex: runningStep.step_index,
              errorMessage: timeoutMessage
            });
            failed += 1;
            resultRows.push({
              workflow_run_id: workflowRunId,
              status: "failed",
              error: timeoutMessage
            });
            continue;
          }
        }
      }

      const advanced = await advanceWorkflowRun({
        supabase,
        orgId,
        workflowRunId,
        actorId
      });
      const status = advanced.status;
      if (status === "completed") {
        completed += 1;
      } else if (status === "running") {
        stillRunning += 1;
      } else if (status === "failed") {
        failed += 1;
      }

      resultRows.push({
        workflow_run_id: workflowRunId,
        status
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "workflow tick advance failed";
      const nowIso = new Date().toISOString();
      await supabase
        .from("workflow_runs")
        .update({
          status: "failed",
          finished_at: nowIso
        })
        .eq("id", workflowRunId)
        .eq("org_id", orgId);

      await appendTaskEvent({
        supabase,
        orgId,
        taskId,
        actorType: "system",
        actorId: null,
        eventType: "WORKFLOW_FAILED",
        payload: {
          workflow_run_id: workflowRunId,
          step_key: row.current_step_key ?? null,
          error: `workflow_tick: ${message.slice(0, 500)}`
        }
      });

      resultRows.push({
        workflow_run_id: workflowRunId,
        status: "failed",
        error: message
      });
    }
  }

  return {
    scanned: (runs ?? []).length,
    completed,
    running: stillRunning,
    failed,
    results: resultRows
  };
}
