"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { executeTaskDraftActionShared } from "@/lib/actions/executeDraft";
import { decideApprovalShared } from "@/lib/approvals/decide";
import { parseChatIntent } from "@/lib/chat/intents";
import { getOrCreateChatSession, type ChatScope } from "@/lib/chat/sessions";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { postApprovalRequestToSlack } from "@/lib/slack/approvals";
import { createClient } from "@/lib/supabase/server";

function pathForScope(scope: ChatScope) {
  return scope === "shared" ? "/app/chat/shared" : "/app/chat/me";
}

function withError(scope: ChatScope, message: string) {
  return `${pathForScope(scope)}?error=${encodeURIComponent(message)}`;
}

function withOk(scope: ChatScope, message: string) {
  return `${pathForScope(scope)}?ok=${encodeURIComponent(message)}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function addSystemMessage(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  sessionId: string;
  bodyText: string;
  metadata?: Record<string, unknown>;
}) {
  await args.supabase.from("chat_messages").insert({
    org_id: args.orgId,
    session_id: args.sessionId,
    sender_type: "system",
    sender_user_id: null,
    body_text: args.bodyText,
    metadata_json: args.metadata ?? {}
  });
}

async function saveIntentConfirmation(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  sessionId: string;
  intentId: string;
}) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const { error } = await args.supabase.from("chat_confirmations").insert({
    org_id: args.orgId,
    session_id: args.sessionId,
    intent_id: args.intentId,
    status: "pending",
    expires_at: expiresAt
  });
  if (error) {
    throw new Error(`実行確認の作成に失敗しました: ${error.message}`);
  }
  return { expiresAt };
}

async function findActiveAgentId(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
}) {
  const { supabase, orgId } = args;
  const { data: preferredAgent } = await supabase
    .from("agents")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .eq("role_key", "accounting")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (preferredAgent?.id) {
    return preferredAgent.id as string;
  }

  const { data: firstAgent } = await supabase
    .from("agents")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return (firstAgent?.id as string | undefined) ?? null;
}

async function findTaskForChat(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  taskHint: string | null;
}) {
  const { supabase, orgId, taskHint } = args;
  let query = supabase
    .from("tasks")
    .select("id, title, status, created_at")
    .eq("org_id", orgId)
    .in("status", ["draft", "ready_for_approval", "approved"]);

  if (taskHint) {
    query = query.or(`title.ilike.%${taskHint}%,id.eq.${taskHint}`);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(6);
  if (error) {
    throw new Error(`対象タスクの検索に失敗しました: ${error.message}`);
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    throw new Error(taskHint ? `「${taskHint}」に一致するタスクがありません。` : "対象タスクが見つかりません。`task`名を明示してください。");
  }

  if (!taskHint && rows.length > 1) {
    const previews = rows
      .slice(0, 3)
      .map((row) => `- ${row.title as string} (${row.id as string})`)
      .join("\n");
    throw new Error(`対象タスクが複数あります。タスク名を「」で指定してください:\n${previews}`);
  }

  if (taskHint) {
    const exactById = rows.find((row) => String(row.id) === taskHint);
    if (exactById) {
      return {
        id: exactById.id as string,
        title: exactById.title as string,
        status: exactById.status as string
      };
    }
    const exactByTitle = rows.find((row) => String(row.title) === taskHint);
    if (exactByTitle) {
      return {
        id: exactByTitle.id as string,
        title: exactByTitle.title as string,
        status: exactByTitle.status as string
      };
    }
    if (rows.length > 1) {
      const previews = rows
        .slice(0, 3)
        .map((row) => `- ${row.title as string} (${row.id as string})`)
        .join("\n");
      throw new Error(`候補が複数あります。task_id か完全なタスク名を指定してください:\n${previews}`);
    }
  }

  const first = rows[0];
  return {
    id: first.id as string,
    title: first.title as string,
    status: first.status as string
  };
}

async function findPendingApprovalForChat(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  taskHint: string | null;
}) {
  const { supabase, orgId, taskHint } = args;

  if (taskHint) {
    const task = await findTaskForChat({ supabase, orgId, taskHint });
    const { data: approval, error } = await supabase
      .from("approvals")
      .select("id, task_id")
      .eq("org_id", orgId)
      .eq("task_id", task.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`承認検索に失敗しました: ${error.message}`);
    }
    if (!approval) {
      throw new Error(`「${task.title}」の承認待ちはありません。`);
    }
    return {
      approvalId: approval.id as string,
      taskId: approval.task_id as string,
      taskTitle: task.title
    };
  }

  const { data: approvals, error } = await supabase
    .from("approvals")
    .select("id, task_id")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) {
    throw new Error(`承認検索に失敗しました: ${error.message}`);
  }
  if (!approvals || approvals.length === 0) {
    throw new Error("承認待ちがありません。");
  }
  if (approvals.length > 1) {
    const taskIds = approvals.map((row) => row.task_id as string);
    const { data: taskRows } = await supabase
      .from("tasks")
      .select("id, title")
      .eq("org_id", orgId)
      .in("id", taskIds);
    const titleById = new Map((taskRows ?? []).map((row) => [row.id as string, row.title as string]));
    const previews = approvals
      .slice(0, 3)
      .map((row) => `- ${titleById.get(row.task_id as string) ?? (row.task_id as string)} (${row.task_id as string})`)
      .join("\n");
    throw new Error(`承認待ちが複数あります。対象タスクを指定してください:\n${previews}`);
  }
  const approval = approvals[0];

  const { data: taskRow } = await supabase
    .from("tasks")
    .select("title")
    .eq("id", approval.task_id as string)
    .eq("org_id", orgId)
    .maybeSingle();

  return {
    approvalId: approval.id as string,
    taskId: approval.task_id as string,
    taskTitle: ((taskRow?.title as string | undefined) ?? approval.task_id) as string
  };
}

async function runCreateTaskCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const title = typeof intentJson.title === "string" ? intentJson.title : "チャット起点タスク";
  const inputText = typeof intentJson.inputText === "string" ? intentJson.inputText : title;

  const agentId = await findActiveAgentId({ supabase, orgId });
  if (!agentId) {
    throw new Error("activeエージェントを作成してから再実行してください。");
  }

  const { data: createdTask, error: taskError } = await supabase
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

  if (taskError) {
    throw new Error(`タスク作成に失敗しました: ${taskError.message}`);
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: createdTask.id as string,
    actorType: "user",
    actorId: userId,
    eventType: "TASK_CREATED",
    payload: {
      changed_fields: {
        title: createdTask.title,
        status: createdTask.status,
        agent_id: createdTask.agent_id,
        source: "chat_command"
      }
    }
  });

  return {
    executionRefType: "task",
    executionRefId: createdTask.id as string,
    result: { task_id: createdTask.id, title: createdTask.title },
    message: `タスクを作成しました: ${createdTask.title as string} (/app/tasks/${createdTask.id as string})`,
    touchedTaskId: createdTask.id as string
  };
}

async function runRequestApprovalCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const taskHint = typeof intentJson.taskHint === "string" ? intentJson.taskHint : null;
  const task = await findTaskForChat({ supabase, orgId, taskHint });

  const [{ data: latestModelEvent, error: modelError }, { data: latestPolicyEvent, error: policyError }] = await Promise.all([
    supabase
      .from("task_events")
      .select("payload_json")
      .eq("org_id", orgId)
      .eq("task_id", task.id)
      .eq("event_type", "MODEL_INFERRED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("task_events")
      .select("payload_json")
      .eq("org_id", orgId)
      .eq("task_id", task.id)
      .eq("event_type", "POLICY_CHECKED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  if (modelError) {
    throw new Error(`ドラフト取得に失敗しました: ${modelError.message}`);
  }
  if (!latestModelEvent) {
    throw new Error("承認依頼の前にドラフト生成が必要です。");
  }
  if (policyError) {
    throw new Error(`ポリシー取得に失敗しました: ${policyError.message}`);
  }
  if (!latestPolicyEvent) {
    throw new Error("承認依頼の前にポリシーチェックが必要です。");
  }

  const policyPayload = asObject(latestPolicyEvent.payload_json);
  if (policyPayload.status === "block") {
    throw new Error("policy status が block のため承認依頼できません。");
  }

  const { data: pendingApproval, error: pendingError } = await supabase
    .from("approvals")
    .select("id")
    .eq("org_id", orgId)
    .eq("task_id", task.id)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (pendingError) {
    throw new Error(`既存承認チェックに失敗しました: ${pendingError.message}`);
  }
  if (pendingApproval) {
    throw new Error("このタスクにはすでに承認待ちがあります。");
  }

  const { data: approval, error: approvalError } = await supabase
    .from("approvals")
    .insert({
      org_id: orgId,
      task_id: task.id,
      requested_by: userId,
      status: "pending"
    })
    .select("id")
    .single();
  if (approvalError) {
    throw new Error(`承認依頼作成に失敗しました: ${approvalError.message}`);
  }

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: task.id,
    actorType: "user",
    actorId: userId,
    eventType: "APPROVAL_REQUESTED",
    payload: {
      approval_id: approval.id,
      source: "chat_command"
    }
  });

  if (task.status !== "ready_for_approval") {
    const { error: updateTaskError } = await supabase
      .from("tasks")
      .update({ status: "ready_for_approval" })
      .eq("id", task.id)
      .eq("org_id", orgId);
    if (updateTaskError) {
      throw new Error(`タスク状態更新に失敗しました: ${updateTaskError.message}`);
    }

    await appendTaskEvent({
      supabase,
      orgId,
      taskId: task.id,
      actorType: "user",
      actorId: userId,
      eventType: "TASK_UPDATED",
      payload: {
        changed_fields: {
          status: {
            from: task.status,
            to: "ready_for_approval"
          }
        },
        source: "chat_request_approval"
      }
    });
  }

  const modelPayload = asObject(latestModelEvent.payload_json);
  const modelOutput = asObject(modelPayload.output);
  const draftSummary = typeof modelOutput.summary === "string" ? modelOutput.summary : null;
  const policyStatus = typeof policyPayload.status === "string" ? policyPayload.status : null;

  try {
    const slackMessage = await postApprovalRequestToSlack({
      supabase,
      orgId,
      approvalId: approval.id as string,
      taskId: task.id,
      taskTitle: task.title,
      draftSummary,
      policyStatus
    });
    if (slackMessage) {
      await appendTaskEvent({
        supabase,
        orgId,
        taskId: task.id,
        actorType: "system",
        actorId: null,
        eventType: "SLACK_APPROVAL_POSTED",
        payload: {
          channel_id: slackMessage.channel,
          slack_ts: slackMessage.ts,
          approval_id: approval.id,
          source: "chat_command"
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "slack_error";
    await appendTaskEvent({
      supabase,
      orgId,
      taskId: task.id,
      actorType: "system",
      actorId: null,
      eventType: "SLACK_APPROVAL_POSTED",
      payload: {
        approval_id: approval.id,
        source: "chat_command",
        error: message
      }
    });
  }

  return {
    executionRefType: "approval",
    executionRefId: approval.id as string,
    result: { approval_id: approval.id, task_id: task.id },
    message: `承認依頼を作成しました: ${task.title} (/app/tasks/${task.id})`,
    touchedTaskId: task.id
  };
}

async function runDecideApprovalCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const decision = intentJson.decision === "rejected" ? "rejected" : "approved";
  const taskHint = typeof intentJson.taskHint === "string" ? intentJson.taskHint : null;
  const reason = typeof intentJson.reason === "string" ? intentJson.reason : "chat_command";

  const target = await findPendingApprovalForChat({ supabase, orgId, taskHint });
  const decided = await decideApprovalShared({
    supabase,
    approvalId: target.approvalId,
    decision,
    reason,
    actorType: "user",
    actorId: userId,
    source: "chat",
    expectedOrgId: orgId
  });

  return {
    executionRefType: "approval",
    executionRefId: decided.approvalId,
    result: {
      approval_id: decided.approvalId,
      task_id: decided.taskId,
      decision: decided.approvalStatus
    },
    message:
      decision === "approved"
        ? `承認しました: ${target.taskTitle} (/app/tasks/${decided.taskId})`
        : `却下しました: ${target.taskTitle} (/app/tasks/${decided.taskId})`,
    touchedTaskId: decided.taskId
  };
}

async function runExecuteActionCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const taskHint = typeof intentJson.taskHint === "string" ? intentJson.taskHint : null;
  const task = await findTaskForChat({ supabase, orgId, taskHint });

  const result = await executeTaskDraftActionShared({
    supabase,
    orgId,
    userId,
    taskId: task.id,
    source: "chat_command"
  });

  return {
    executionRefType: "action",
    executionRefId: result.actionId,
    result: {
      task_id: task.id,
      action_id: result.actionId,
      status: result.status,
      reason: result.reason ?? null
    },
    message:
      result.status === "success"
        ? `メール実行が完了しました: ${task.title} (/app/tasks/${task.id})`
        : `メール実行はスキップされました: ${result.message} (/app/tasks/${task.id})`,
    touchedTaskId: task.id
  };
}

async function executeIntentCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentType: string;
  intentJson: Record<string, unknown>;
}) {
  if (args.intentType === "create_task") {
    return runCreateTaskCommand(args);
  }
  if (args.intentType === "request_approval") {
    return runRequestApprovalCommand(args);
  }
  if (args.intentType === "decide_approval") {
    return runDecideApprovalCommand(args);
  }
  if (args.intentType === "execute_action") {
    return runExecuteActionCommand(args);
  }
  throw new Error("この実行タイプは未対応です。");
}

async function postMessage(scope: ChatScope, formData: FormData) {
  const body = String(formData.get("body") ?? "").trim();
  if (!body) {
    redirect(withError(scope, "メッセージを入力してください。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const session = await getOrCreateChatSession({
    supabase,
    orgId,
    scope,
    userId
  });

  const { data: userMsg, error: userMsgError } = await supabase
    .from("chat_messages")
    .insert({
      org_id: orgId,
      session_id: session.id,
      sender_type: "user",
      sender_user_id: userId,
      body_text: body,
      metadata_json: {
        scope
      }
    })
    .select("id")
    .single();

  if (userMsgError) {
    redirect(withError(scope, `メッセージ保存に失敗しました: ${userMsgError.message}`));
  }

  const intent = parseChatIntent(body);
  const { data: intentRow, error: intentError } = await supabase
    .from("chat_intents")
    .insert({
      org_id: orgId,
      message_id: userMsg.id,
      intent_type: intent.intentType,
      confidence: intent.confidence,
      intent_json: intent.plan
    })
    .select("id")
    .single();

  if (intentError) {
    redirect(withError(scope, `意図解析保存に失敗しました: ${intentError.message}`));
  }

  await supabase
    .from("chat_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", session.id)
    .eq("org_id", orgId);

  if (intent.intentType === "status_query") {
    const taskHint = typeof intent.plan.taskHint === "string" ? intent.plan.taskHint : null;
    if (taskHint) {
      const task = await findTaskForChat({ supabase, orgId, taskHint });
      const [{ data: pendingApproval }, { data: latestAction }, { data: latestEvent }] = await Promise.all([
        supabase
          .from("approvals")
          .select("id")
          .eq("org_id", orgId)
          .eq("task_id", task.id)
          .eq("status", "pending")
          .limit(1)
          .maybeSingle(),
        supabase
          .from("actions")
          .select("status, created_at")
          .eq("org_id", orgId)
          .eq("task_id", task.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("task_events")
          .select("event_type, created_at")
          .eq("org_id", orgId)
          .eq("task_id", task.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      ]);

      await addSystemMessage({
        supabase,
        orgId,
        sessionId: session.id,
        bodyText:
          `タスク状況:\n` +
          `- title: ${task.title}\n` +
          `- status: ${task.status}\n` +
          `- 承認待ち: ${pendingApproval ? "あり" : "なし"}\n` +
          `- 最新アクション: ${latestAction?.status ?? "なし"}\n` +
          `- 最新イベント: ${latestEvent?.event_type ?? "なし"}`,
        metadata: {
          intent_id: intentRow.id,
          intent_type: intent.intentType,
          task_id: task.id
        }
      });
    } else {
      const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const [{ count: taskCount }, { count: pendingApprovalCount }, { count: actionFailCount }] = await Promise.all([
        supabase.from("tasks").select("id", { count: "exact", head: true }).eq("org_id", orgId),
        supabase.from("approvals").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "pending"),
        supabase
          .from("actions")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "failed")
          .gte("created_at", sevenDaysAgoIso)
      ]);

      await addSystemMessage({
        supabase,
        orgId,
        sessionId: session.id,
        bodyText:
          `現状サマリ:\n` +
          `- タスク総数: ${taskCount ?? 0}\n` +
          `- 承認待ち: ${pendingApprovalCount ?? 0}\n` +
          `- 7日失敗アクション: ${actionFailCount ?? 0}`,
        metadata: {
          intent_id: intentRow.id,
          intent_type: intent.intentType
        }
      });
    }

    revalidatePath(pathForScope(scope));
    redirect(withOk(scope, "状況を要約しました。"));
  }

  if (intent.requiresConfirmation) {
    try {
      const { expiresAt } = await saveIntentConfirmation({
        supabase,
        orgId,
        sessionId: session.id,
        intentId: intentRow.id as string
      });
      await addSystemMessage({
        supabase,
        orgId,
        sessionId: session.id,
        bodyText: `${intent.plan.summary}\nこの操作を実行してよいですか？（Yes/No）`,
        metadata: {
          intent_id: intentRow.id,
          intent_type: intent.intentType,
          requires_confirmation: true,
          expires_at: expiresAt
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "実行確認作成に失敗しました。";
      redirect(withError(scope, message));
    }

    revalidatePath(pathForScope(scope));
    redirect(withOk(scope, "実行確認を作成しました。"));
  }

  await addSystemMessage({
    supabase,
    orgId,
    sessionId: session.id,
    bodyText: intent.plan.summary,
    metadata: {
      intent_id: intentRow.id,
      intent_type: intent.intentType
    }
  });

  revalidatePath(pathForScope(scope));
  redirect(withOk(scope, "回答を返しました。"));
}

export async function postSharedMessage(formData: FormData) {
  return postMessage("shared", formData);
}

export async function postPersonalMessage(formData: FormData) {
  return postMessage("personal", formData);
}

export async function confirmChatCommand(formData: FormData) {
  const confirmationId = String(formData.get("confirmation_id") ?? "").trim();
  const scope = String(formData.get("scope") ?? "shared").trim() === "personal" ? "personal" : "shared";
  const decision = String(formData.get("decision") ?? "").trim();

  if (!confirmationId || (decision !== "confirmed" && decision !== "declined")) {
    redirect(withError(scope, "確認リクエストが不正です。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: confirmation, error: confirmationError } = await supabase
    .from("chat_confirmations")
    .select("id, intent_id, session_id, status, expires_at")
    .eq("id", confirmationId)
    .eq("org_id", orgId)
    .single();

  if (confirmationError) {
    redirect(withError(scope, `確認情報の取得に失敗しました: ${confirmationError.message}`));
  }

  if (confirmation.status !== "pending") {
    redirect(withError(scope, "この確認はすでに処理済みです。"));
  }

  const expiresAt = new Date(confirmation.expires_at as string).getTime();
  if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
    await supabase
      .from("chat_confirmations")
      .update({ status: "expired", decided_at: new Date().toISOString(), decided_by: userId })
      .eq("id", confirmationId)
      .eq("org_id", orgId);
    redirect(withError(scope, "確認期限が切れています。もう一度依頼してください。"));
  }

  const { data: intent, error: intentError } = await supabase
    .from("chat_intents")
    .select("id, intent_type, intent_json")
    .eq("id", confirmation.intent_id as string)
    .eq("org_id", orgId)
    .single();
  if (intentError) {
    redirect(withError(scope, `意図情報の取得に失敗しました: ${intentError.message}`));
  }

  const nowIso = new Date().toISOString();
  await supabase
    .from("chat_confirmations")
    .update({
      status: decision,
      decided_at: nowIso,
      decided_by: userId
    })
    .eq("id", confirmationId)
    .eq("org_id", orgId);

  if (decision === "declined") {
    await addSystemMessage({
      supabase,
      orgId,
      sessionId: confirmation.session_id as string,
      bodyText: "実行をキャンセルしました。",
      metadata: {
        confirmation_id: confirmationId,
        intent_id: intent.id,
        decision
      }
    });
    revalidatePath(pathForScope(scope));
    redirect(withOk(scope, "実行をキャンセルしました。"));
  }

  const { data: command, error: commandError } = await supabase
    .from("chat_commands")
    .insert({
      org_id: orgId,
      session_id: confirmation.session_id as string,
      intent_id: intent.id as string,
      execution_status: "pending",
      result_json: {
        confirmation_id: confirmationId
      }
    })
    .select("id")
    .single();
  if (commandError) {
    redirect(withError(scope, `コマンド生成に失敗しました: ${commandError.message}`));
  }

  await supabase
    .from("chat_commands")
    .update({ execution_status: "running" })
    .eq("id", command.id as string)
    .eq("org_id", orgId);

  try {
    const intentJson = asObject(intent.intent_json);
    const executed = await executeIntentCommand({
      supabase,
      orgId,
      userId,
      intentType: intent.intent_type as string,
      intentJson
    });

    await supabase
      .from("chat_commands")
      .update({
        execution_status: "done",
        execution_ref_type: executed.executionRefType,
        execution_ref_id: executed.executionRefId,
        result_json: executed.result,
        finished_at: new Date().toISOString()
      })
      .eq("id", command.id as string)
      .eq("org_id", orgId);

    await addSystemMessage({
      supabase,
      orgId,
      sessionId: confirmation.session_id as string,
      bodyText: executed.message,
      metadata: {
        confirmation_id: confirmationId,
        intent_id: intent.id,
        command_id: command.id,
        execution_ref_id: executed.executionRefId,
        execution_ref_type: executed.executionRefType
      }
    });

    revalidatePath(pathForScope(scope));
    revalidatePath("/app/tasks");
    revalidatePath("/app/approvals");
    if (executed.touchedTaskId) {
      revalidatePath(`/app/tasks/${executed.touchedTaskId}`);
    }

    redirect(withOk(scope, "実行が完了しました。"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "コマンド実行に失敗しました。";

    await supabase
      .from("chat_commands")
      .update({
        execution_status: "failed",
        result_json: {
          error: message
        },
        finished_at: new Date().toISOString()
      })
      .eq("id", command.id as string)
      .eq("org_id", orgId);

    await addSystemMessage({
      supabase,
      orgId,
      sessionId: confirmation.session_id as string,
      bodyText: `実行に失敗しました: ${message}`,
      metadata: {
        confirmation_id: confirmationId,
        intent_id: intent.id,
        command_id: command.id,
        error: message
      }
    });

    revalidatePath(pathForScope(scope));
    redirect(withError(scope, message));
  }
}
