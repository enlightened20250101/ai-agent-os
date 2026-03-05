"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { parseChatIntent } from "@/lib/chat/intents";
import { getOrCreateChatSession, type ChatScope } from "@/lib/chat/sessions";
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
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [{ count: taskCount }, { count: pendingApprovalCount }, { count: actionFailCount }] = await Promise.all([
      supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId),
      supabase
        .from("approvals")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", "pending"),
      supabase
        .from("actions")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", "failed")
        .gte("created_at", sevenDaysAgoIso)
    ]);

    await supabase.from("chat_messages").insert({
      org_id: orgId,
      session_id: session.id,
      sender_type: "system",
      sender_user_id: null,
      body_text:
        `現状サマリ:\n` +
        `- タスク総数: ${taskCount ?? 0}\n` +
        `- 承認待ち: ${pendingApprovalCount ?? 0}\n` +
        `- 7日失敗アクション: ${actionFailCount ?? 0}`,
      metadata_json: {
        intent_id: intentRow.id,
        intent_type: intent.intentType
      }
    });

    revalidatePath(pathForScope(scope));
    redirect(withOk(scope, "状況を要約しました。"));
  }

  if (intent.intentType === "create_task" && intent.requiresConfirmation) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { error: confirmationError } = await supabase.from("chat_confirmations").insert({
      org_id: orgId,
      session_id: session.id,
      intent_id: intentRow.id,
      status: "pending",
      expires_at: expiresAt
    });

    if (confirmationError) {
      redirect(withError(scope, `実行確認の作成に失敗しました: ${confirmationError.message}`));
    }

    await supabase.from("chat_messages").insert({
      org_id: orgId,
      session_id: session.id,
      sender_type: "system",
      sender_user_id: null,
      body_text: `${intent.plan.summary}\nこの操作を実行してよいですか？（Yes/No）`,
      metadata_json: {
        intent_id: intentRow.id,
        intent_type: intent.intentType,
        requires_confirmation: true,
        expires_at: expiresAt
      }
    });

    revalidatePath(pathForScope(scope));
    redirect(withOk(scope, "実行確認を作成しました。"));
  }

  await supabase.from("chat_messages").insert({
    org_id: orgId,
    session_id: session.id,
    sender_type: "system",
    sender_user_id: null,
    body_text: intent.plan.summary,
    metadata_json: {
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
    await supabase.from("chat_messages").insert({
      org_id: orgId,
      session_id: confirmation.session_id as string,
      sender_type: "system",
      sender_user_id: null,
      body_text: "実行をキャンセルしました。",
      metadata_json: {
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

  if (intent.intent_type === "create_task") {
    const intentJson =
      typeof intent.intent_json === "object" && intent.intent_json !== null
        ? (intent.intent_json as Record<string, unknown>)
        : null;
    const title = typeof intentJson?.title === "string" ? intentJson.title : "チャット起点タスク";
    const inputText = typeof intentJson?.inputText === "string" ? intentJson.inputText : title;

    const { data: preferredAgent } = await supabase
      .from("agents")
      .select("id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .eq("role_key", "accounting")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    let agentId = (preferredAgent?.id as string | undefined) ?? null;
    if (!agentId) {
      const { data: firstAgent } = await supabase
        .from("agents")
        .select("id")
        .eq("org_id", orgId)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      agentId = (firstAgent?.id as string | undefined) ?? null;
    }

    if (!agentId) {
      await supabase
        .from("chat_commands")
        .update({
          execution_status: "failed",
          result_json: {
            error: "active agent not found"
          },
          finished_at: new Date().toISOString()
        })
        .eq("id", command.id as string)
        .eq("org_id", orgId);

      await supabase.from("chat_messages").insert({
        org_id: orgId,
        session_id: confirmation.session_id as string,
        sender_type: "system",
        sender_user_id: null,
        body_text: "実行に失敗しました。activeエージェントを作成してから再実行してください。",
        metadata_json: {
          confirmation_id: confirmationId,
          intent_id: intent.id,
          command_id: command.id
        }
      });

      revalidatePath(pathForScope(scope));
      redirect(withError(scope, "activeエージェントが見つからないため実行できませんでした。"));
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
      await supabase
        .from("chat_commands")
        .update({
          execution_status: "failed",
          result_json: {
            error: taskError.message
          },
          finished_at: new Date().toISOString()
        })
        .eq("id", command.id as string)
        .eq("org_id", orgId);
      redirect(withError(scope, `タスク作成に失敗しました: ${taskError.message}`));
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
        },
        chat: {
          confirmation_id: confirmationId,
          intent_id: intent.id,
          command_id: command.id,
          session_id: confirmation.session_id
        }
      }
    });

    await supabase
      .from("chat_commands")
      .update({
        execution_status: "done",
        execution_ref_type: "task",
        execution_ref_id: createdTask.id,
        result_json: {
          task_id: createdTask.id,
          title: createdTask.title
        },
        finished_at: new Date().toISOString()
      })
      .eq("id", command.id as string)
      .eq("org_id", orgId);

    await supabase.from("chat_messages").insert({
      org_id: orgId,
      session_id: confirmation.session_id as string,
      sender_type: "system",
      sender_user_id: null,
      body_text: `タスクを作成しました: ${createdTask.title as string} (/app/tasks/${createdTask.id as string})`,
      metadata_json: {
        confirmation_id: confirmationId,
        intent_id: intent.id,
        command_id: command.id,
        task_id: createdTask.id
      }
    });

    revalidatePath(pathForScope(scope));
    revalidatePath("/app/tasks");
    revalidatePath(`/app/tasks/${createdTask.id as string}`);
    redirect(withOk(scope, "タスクを作成しました。"));
  }

  await supabase
    .from("chat_commands")
    .update({ execution_status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", command.id as string)
    .eq("org_id", orgId);

  await supabase.from("chat_messages").insert({
    org_id: orgId,
    session_id: confirmation.session_id as string,
    sender_type: "system",
    sender_user_id: null,
    body_text: "この意図タイプの実行には未対応です。",
    metadata_json: {
      confirmation_id: confirmationId,
      intent_id: intent.id,
      command_id: command.id
    }
  });

  revalidatePath(pathForScope(scope));
  redirect(withError(scope, "この実行タイプは未対応です。"));
}
