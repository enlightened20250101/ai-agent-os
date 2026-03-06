"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { executeTaskDraftActionShared } from "@/lib/actions/executeDraft";
import { decideApprovalShared } from "@/lib/approvals/decide";
import { appendCaseEventSafe } from "@/lib/cases/events";
import { parseChatIntent } from "@/lib/chat/intents";
import { expirePendingChatConfirmations } from "@/lib/chat/maintenance";
import { getOrCreateChatSession, type ChatScope } from "@/lib/chat/sessions";
import { appendAiExecutionLog } from "@/lib/executions/logs";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { getLatestOpenIncident } from "@/lib/governance/incidents";
import { requireOrgContext } from "@/lib/org/context";
import { runPlanner } from "@/lib/planner/runPlanner";
import { acceptProposalShared } from "@/lib/proposals/decide";
import { postApprovalRequestToSlack } from "@/lib/slack/approvals";
import { createClient } from "@/lib/supabase/server";
import { retryFailedWorkflowRun, startWorkflowRun } from "@/lib/workflows/orchestrator";

function normalizeScope(raw: string): ChatScope {
  if (raw === "shared" || raw === "personal" || raw === "channel") return raw;
  return "shared";
}

function pathForScope(scope: ChatScope, channelId?: string | null) {
  if (scope === "shared") return "/app/chat/shared";
  if (scope === "personal") return "/app/chat/me";
  if (channelId) return `/app/chat/channels/${channelId}`;
  return "/app/chat/channels";
}

function withError(scope: ChatScope, message: string, channelId?: string | null) {
  return `${pathForScope(scope, channelId)}?error=${encodeURIComponent(message)}`;
}

function withOk(scope: ChatScope, message: string, channelId?: string | null) {
  return `${pathForScope(scope, channelId)}?ok=${encodeURIComponent(message)}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function candidateTaskExamples(rows: Array<{ id: string; title: string }>, actionLabel: string) {
  return rows
    .slice(0, 2)
    .map((row) => `- 「${row.title}」を${actionLabel}（task_id: ${row.id}）`)
    .join("\n");
}

function isBlockedByIncident(intentType: string) {
  return (
    intentType === "decide_approval" ||
    intentType === "bulk_decide_approvals" ||
    intentType === "quick_top_action" ||
    intentType === "execute_action" ||
    intentType === "run_planner" ||
    intentType === "run_workflow" ||
    intentType === "bulk_retry_failed_workflows"
  );
}

function isMutatingIntent(intentType: string) {
  return (
    intentType === "create_task" ||
    intentType === "accept_proposal" ||
    intentType === "request_approval" ||
    intentType === "decide_approval" ||
    intentType === "bulk_decide_approvals" ||
    intentType === "bulk_retry_failed_commands" ||
    intentType === "bulk_retry_failed_workflows" ||
    intentType === "quick_top_action" ||
    intentType === "execute_action" ||
    intentType === "run_planner" ||
    intentType === "run_workflow" ||
    intentType === "update_case_status" ||
    intentType === "update_case_owner_self" ||
    intentType === "update_case_due"
  );
}

function extractMentions(text: string) {
  const matches = text.match(/@[A-Za-z0-9_.-]+/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.slice(1))));
}

function hasAiMention(text: string) {
  return /(^|\s)@ai\b/i.test(text);
}

function stripAiMention(text: string) {
  return text.replace(/(^|\s)@ai\b/gi, " ").replace(/\s+/g, " ").trim();
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

async function assertConfirmationGuardrails(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  sessionId: string;
}) {
  const pendingLimit = Number(process.env.CHAT_CONFIRMATION_PENDING_LIMIT ?? "5");
  const cooldownSeconds = Number(process.env.CHAT_CONFIRMATION_COOLDOWN_SECONDS ?? "8");
  const limit = Number.isFinite(pendingLimit) && pendingLimit > 0 ? pendingLimit : 5;
  const cooldown = Number.isFinite(cooldownSeconds) && cooldownSeconds >= 0 ? cooldownSeconds : 8;

  const { data: pendingRows, error: pendingError } = await args.supabase
    .from("chat_confirmations")
    .select("id, created_at")
    .eq("org_id", args.orgId)
    .eq("session_id", args.sessionId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (pendingError) {
    throw new Error(`確認キューの取得に失敗しました: ${pendingError.message}`);
  }

  const rows = pendingRows ?? [];
  if (rows.length >= limit) {
    throw new Error(`確認待ちが上限(${limit})に達しています。先にYes/Noで処理してください。`);
  }

  const latestCreatedAt = rows[0]?.created_at;
  if (latestCreatedAt && cooldown > 0) {
    const latestTs = new Date(latestCreatedAt as string).getTime();
    if (Number.isFinite(latestTs)) {
      const deltaSec = Math.floor((Date.now() - latestTs) / 1000);
      if (deltaSec < cooldown) {
        throw new Error(`確認作成が短時間に連続しています。${cooldown - deltaSec}秒待って再実行してください。`);
      }
    }
  }
}

async function assertUserDailyExecutionLimit(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentType: string;
}) {
  if (!isMutatingIntent(args.intentType)) {
    return;
  }

  const limitRaw = Number.parseInt(process.env.CHAT_DAILY_EXECUTION_LIMIT ?? "30", 10);
  const limit = Number.isNaN(limitRaw) ? 30 : Math.max(1, Math.min(500, limitRaw));
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();

  const { count, error } = await args.supabase
    .from("chat_confirmations")
    .select("id", { count: "exact", head: true })
    .eq("org_id", args.orgId)
    .eq("decided_by", args.userId)
    .eq("status", "confirmed")
    .gte("decided_at", dayStartIso);
  if (error) {
    throw new Error(`日次実行上限チェックに失敗しました: ${error.message}`);
  }

  const current = count ?? 0;
  if (current >= limit) {
    throw new Error(`本日のチャット実行上限(${limit})に達しました。必要なら管理者へ連絡してください。`);
  }
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
  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  let query = supabase
    .from("tasks")
    .select("id, title, status, created_at")
    .eq("org_id", orgId)
    .in("status", ["draft", "ready_for_approval", "approved"]);

  if (taskHint) {
    if (isUuid(taskHint)) {
      query = query.or(`title.ilike.%${taskHint}%,id.eq.${taskHint}`);
    } else {
      query = query.ilike("title", `%${taskHint}%`);
    }
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
    const examples = candidateTaskExamples(
      rows.map((row) => ({ id: row.id as string, title: row.title as string })),
      "承認依頼して"
    );
    throw new Error(
      `対象タスクが複数あります。タスク名を「」で指定してください:\n${previews}\n\n次のように指定できます:\n${examples}`
    );
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
      const examples = candidateTaskExamples(
        rows.map((row) => ({ id: row.id as string, title: row.title as string })),
        "実行して"
      );
      throw new Error(
        `候補が複数あります。task_id か完全なタスク名を指定してください:\n${previews}\n\n次のように指定できます:\n${examples}`
      );
    }
  }

  const first = rows[0];
  return {
    id: first.id as string,
    title: first.title as string,
    status: first.status as string
  };
}

async function findCaseForChat(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  caseHint: string | null;
}) {
  const { supabase, orgId, caseHint } = args;
  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  let query = supabase
    .from("business_cases")
    .select("id, title, status, owner_user_id, due_at, updated_at")
    .eq("org_id", orgId);

  if (caseHint) {
    if (isUuid(caseHint)) {
      query = query.or(`title.ilike.%${caseHint}%,id.eq.${caseHint}`);
    } else {
      query = query.ilike("title", `%${caseHint}%`);
    }
  }

  const { data, error } = await query.order("updated_at", { ascending: false }).limit(6);
  if (error) {
    throw new Error(`対象案件の検索に失敗しました: ${error.message}`);
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    throw new Error(caseHint ? `「${caseHint}」に一致する案件がありません。` : "対象案件が見つかりません。");
  }

  if (caseHint) {
    const exactById = rows.find((row) => String(row.id) === caseHint);
    if (exactById) {
      return {
        id: exactById.id as string,
        title: exactById.title as string,
        status: String(exactById.status),
        ownerUserId: (exactById.owner_user_id as string | null | undefined) ?? null,
        dueAt: (exactById.due_at as string | null | undefined) ?? null
      };
    }
    const exactByTitle = rows.find((row) => String(row.title) === caseHint);
    if (exactByTitle) {
      return {
        id: exactByTitle.id as string,
        title: exactByTitle.title as string,
        status: String(exactByTitle.status),
        ownerUserId: (exactByTitle.owner_user_id as string | null | undefined) ?? null,
        dueAt: (exactByTitle.due_at as string | null | undefined) ?? null
      };
    }
    if (rows.length > 1) {
      const previews = rows
        .slice(0, 3)
        .map((row) => `- ${row.title as string} (${row.id as string})`)
        .join("\n");
      throw new Error(`候補案件が複数あります。case_id か完全な案件名を指定してください:\n${previews}`);
    }
  }

  const first = rows[0];
  return {
    id: first.id as string,
    title: first.title as string,
    status: String(first.status),
    ownerUserId: (first.owner_user_id as string | null | undefined) ?? null,
    dueAt: (first.due_at as string | null | undefined) ?? null
  };
}

async function getRecentTaskHintFromSession(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  sessionId: string;
}) {
  const { supabase, orgId, sessionId } = args;
  const { data, error } = await supabase
    .from("chat_messages")
    .select("metadata_json")
    .eq("org_id", orgId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    return null;
  }

  for (const row of data ?? []) {
    const metadata = asObject(row.metadata_json);
    if (typeof metadata.task_id === "string") {
      return metadata.task_id;
    }
    if (metadata.execution_ref_type === "task" && typeof metadata.execution_ref_id === "string") {
      return metadata.execution_ref_id;
    }
  }
  return null;
}

async function getRecentTopCandidatesFromSession(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  sessionId: string;
}) {
  const { supabase, orgId, sessionId } = args;
  const { data, error } = await supabase
    .from("chat_messages")
    .select("metadata_json")
    .eq("org_id", orgId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    return null;
  }

  for (const row of data ?? []) {
    const metadata = asObject(row.metadata_json);
    const top = asObject(metadata.status_top_candidates);
    if (Object.keys(top).length === 0) {
      continue;
    }
    const approvals = Array.isArray(top.approval_task_ids) ? top.approval_task_ids.filter((v): v is string => typeof v === "string") : [];
    const proposals = Array.isArray(top.proposal_ids) ? top.proposal_ids.filter((v): v is string => typeof v === "string") : [];
    const exceptions = Array.isArray(top.exception_task_ids)
      ? top.exception_task_ids.filter((v): v is string => typeof v === "string")
      : [];
    const generatedAt =
      typeof top.generated_at === "string" && !Number.isNaN(Date.parse(top.generated_at)) ? top.generated_at : null;
    return {
      approvalTaskIds: approvals,
      proposalIds: proposals,
      exceptionTaskIds: exceptions,
      generatedAt
    };
  }
  return null;
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
    throw new Error(
      `承認待ちが複数あります。対象タスクを指定してください:\n${previews}\n\n例: 「対象タスク名」を承認して`
    );
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

async function findProposalForChat(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  proposalHint: string | null;
}) {
  const { supabase, orgId, proposalHint } = args;
  let query = supabase
    .from("task_proposals")
    .select("id, title, status, policy_status, priority_score, created_at")
    .eq("org_id", orgId)
    .eq("status", "proposed")
    .neq("policy_status", "block");

  if (proposalHint) {
    query = query.or(`title.ilike.%${proposalHint}%,id.eq.${proposalHint}`);
  }

  const { data, error } = await query
    .order("priority_score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(6);
  if (error) {
    throw new Error(`対象提案の検索に失敗しました: ${error.message}`);
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    throw new Error(
      proposalHint ? `「${proposalHint}」に一致する受け入れ可能な提案がありません。` : "受け入れ可能な提案がありません。"
    );
  }

  if (proposalHint) {
    const exactById = rows.find((row) => String(row.id) === proposalHint);
    if (exactById) {
      return {
        id: exactById.id as string,
        title: exactById.title as string
      };
    }
    const exactByTitle = rows.find((row) => String(row.title) === proposalHint);
    if (exactByTitle) {
      return {
        id: exactByTitle.id as string,
        title: exactByTitle.title as string
      };
    }
    if (rows.length > 1) {
      const previews = rows
        .slice(0, 3)
        .map((row) => `- ${row.title as string} (${row.id as string})`)
        .join("\n");
      throw new Error(
        `候補提案が複数あります。proposal_id か完全な提案名を指定してください:\n${previews}\n\n例: 「提案名」を受け入れて`
      );
    }
  }

  const first = rows[0];
  return {
    id: first.id as string,
    title: first.title as string
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

async function runUpdateCaseStatusCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const targetStatus =
    intentJson.status === "open" || intentJson.status === "blocked" || intentJson.status === "closed"
      ? intentJson.status
      : null;
  if (!targetStatus) {
    throw new Error("案件ステータス更新の status 指定が不正です。");
  }
  const caseHint = typeof intentJson.caseHint === "string" ? intentJson.caseHint : null;
  const target = await findCaseForChat({ supabase, orgId, caseHint });

  if (target.status === targetStatus) {
    return {
      executionRefType: "case",
      executionRefId: target.id,
      result: {
        case_id: target.id,
        status: targetStatus,
        skipped: true,
        reason: "already_same_status"
      },
      message: `案件ステータスはすでに ${targetStatus} です: ${target.title} (/app/cases/${target.id})`,
      touchedTaskId: null
    };
  }

  const { error } = await supabase
    .from("business_cases")
    .update({
      status: targetStatus,
      updated_at: new Date().toISOString()
    })
    .eq("id", target.id)
    .eq("org_id", orgId);
  if (error) {
    throw new Error(`案件ステータス更新に失敗しました: ${error.message}`);
  }

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId: target.id,
    actorUserId: userId,
    eventType: "CASE_STATUS_UPDATED",
    payload: {
      changed_fields: {
        status: {
          from: target.status,
          to: targetStatus
        }
      },
      source: "chat_command"
    }
  });

  return {
    executionRefType: "case",
    executionRefId: target.id,
    result: {
      case_id: target.id,
      status_from: target.status,
      status_to: targetStatus
    },
    message: `案件ステータスを更新しました: ${target.title} ${target.status} -> ${targetStatus} (/app/cases/${target.id})`,
    touchedTaskId: null
  };
}

async function runUpdateCaseOwnerSelfCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const caseHint = typeof intentJson.caseHint === "string" ? intentJson.caseHint : null;
  const target = await findCaseForChat({ supabase, orgId, caseHint });
  if (target.ownerUserId === userId) {
    return {
      executionRefType: "case",
      executionRefId: target.id,
      result: {
        case_id: target.id,
        owner_user_id: userId,
        skipped: true,
        reason: "already_owner"
      },
      message: `案件担当はすでにあなたです: ${target.title} (/app/cases/${target.id})`,
      touchedTaskId: null
    };
  }

  const { error } = await supabase
    .from("business_cases")
    .update({
      owner_user_id: userId,
      updated_at: new Date().toISOString()
    })
    .eq("id", target.id)
    .eq("org_id", orgId);
  if (error) {
    throw new Error(`案件担当更新に失敗しました: ${error.message}`);
  }

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId: target.id,
    actorUserId: userId,
    eventType: "CASE_OWNER_UPDATED",
    payload: {
      changed_fields: {
        owner_user_id: {
          from: target.ownerUserId,
          to: userId
        }
      },
      source: "chat_command"
    }
  });

  return {
    executionRefType: "case",
    executionRefId: target.id,
    result: {
      case_id: target.id,
      owner_user_id_from: target.ownerUserId,
      owner_user_id_to: userId
    },
    message: `案件担当をあなたに更新しました: ${target.title} (/app/cases/${target.id})`,
    touchedTaskId: null
  };
}

async function runUpdateCaseDueCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const dueAtRaw = typeof intentJson.dueAt === "string" ? intentJson.dueAt : null;
  if (!dueAtRaw || !Number.isFinite(Date.parse(dueAtRaw))) {
    throw new Error("案件期限更新の dueAt 指定が不正です。");
  }
  const dueAt = new Date(dueAtRaw).toISOString();
  const caseHint = typeof intentJson.caseHint === "string" ? intentJson.caseHint : null;
  const target = await findCaseForChat({ supabase, orgId, caseHint });

  if (target.dueAt && new Date(target.dueAt).toISOString() === dueAt) {
    return {
      executionRefType: "case",
      executionRefId: target.id,
      result: {
        case_id: target.id,
        due_at: dueAt,
        skipped: true,
        reason: "already_due"
      },
      message: `案件期限はすでに同じです: ${target.title} (/app/cases/${target.id})`,
      touchedTaskId: null
    };
  }

  const { error } = await supabase
    .from("business_cases")
    .update({
      due_at: dueAt,
      updated_at: new Date().toISOString()
    })
    .eq("id", target.id)
    .eq("org_id", orgId);
  if (error) {
    throw new Error(`案件期限更新に失敗しました: ${error.message}`);
  }

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId: target.id,
    actorUserId: userId,
    eventType: "CASE_DUE_UPDATED",
    payload: {
      changed_fields: {
        due_at: {
          from: target.dueAt,
          to: dueAt
        }
      },
      source: "chat_command"
    }
  });

  return {
    executionRefType: "case",
    executionRefId: target.id,
    result: {
      case_id: target.id,
      due_at_from: target.dueAt,
      due_at_to: dueAt
    },
    message: `案件期限を更新しました: ${target.title} (/app/cases/${target.id})`,
    touchedTaskId: null
  };
}

async function runRequestApprovalCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  sessionId: string;
  intentJson: Record<string, unknown>;
  quickRef?: Record<string, unknown> | null;
}) {
  const { supabase, orgId, userId, intentJson, sessionId, quickRef = null } = args;
  let taskHint = typeof intentJson.taskHint === "string" ? intentJson.taskHint : null;
  if (!taskHint) {
    taskHint = await getRecentTaskHintFromSession({ supabase, orgId, sessionId });
  }
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
      source: "chat_command",
      quick_ref: quickRef
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
        source: "chat_request_approval",
        quick_ref: quickRef
      }
    });
  }

  if (quickRef) {
    await appendTaskEvent({
      supabase,
      orgId,
      taskId: task.id,
      actorType: "user",
      actorId: userId,
      eventType: "CHAT_QUICK_ACTION_USED",
      payload: {
        ...quickRef,
        linked_action: "request_approval",
        approval_id: approval.id
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
    result: { approval_id: approval.id, task_id: task.id, quick_ref: quickRef },
    message: `承認依頼を作成しました: ${task.title} (/app/tasks/${task.id})`,
    touchedTaskId: task.id
  };
}

async function runDecideApprovalCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  sessionId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson, sessionId } = args;
  const decision = intentJson.decision === "rejected" ? "rejected" : "approved";
  let taskHint = typeof intentJson.taskHint === "string" ? intentJson.taskHint : null;
  if (!taskHint) {
    taskHint = await getRecentTaskHintFromSession({ supabase, orgId, sessionId });
  }
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
  sessionId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson, sessionId } = args;
  let taskHint = typeof intentJson.taskHint === "string" ? intentJson.taskHint : null;
  if (!taskHint) {
    taskHint = await getRecentTaskHintFromSession({ supabase, orgId, sessionId });
  }
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

async function runBulkDecideApprovalsCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const decision = intentJson.decision === "rejected" ? "rejected" : "approved";
  const maxItemsRaw = typeof intentJson.maxItems === "number" ? intentJson.maxItems : Number.NaN;
  const maxItems = Number.isFinite(maxItemsRaw) ? Math.max(1, Math.min(10, Math.floor(maxItemsRaw))) : 3;
  const reason = typeof intentJson.reason === "string" ? intentJson.reason : "chat_bulk";

  const { data: pendingRows, error: pendingError } = await supabase
    .from("approvals")
    .select("id, task_id, created_at")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(maxItems);
  if (pendingError) {
    throw new Error(`承認待ち一覧の取得に失敗しました: ${pendingError.message}`);
  }
  const targets = pendingRows ?? [];
  if (targets.length === 0) {
    throw new Error("承認待ちがありません。");
  }

  const decidedTaskIds: string[] = [];
  const failedApprovalIds: string[] = [];

  for (const row of targets) {
    try {
      const decided = await decideApprovalShared({
        supabase,
        approvalId: row.id as string,
        decision,
        reason,
        actorType: "user",
        actorId: userId,
        source: "chat",
        expectedOrgId: orgId
      });
      decidedTaskIds.push(decided.taskId);
    } catch (error) {
      failedApprovalIds.push(row.id as string);
      const message = error instanceof Error ? error.message : "unknown";
      console.error(`[CHAT_BULK_APPROVAL_DECIDE_FAILED] approval_id=${row.id as string} ${message}`);
    }
  }

  if (decidedTaskIds.length === 0) {
    throw new Error("一括承認処理に失敗しました。");
  }

  return {
    executionRefType: "approval",
    executionRefId: (targets[0]?.id as string) ?? null,
    result: {
      decision,
      requested_count: maxItems,
      processed_count: targets.length,
      succeeded_count: decidedTaskIds.length,
      failed_count: failedApprovalIds.length,
      failed_approval_ids: failedApprovalIds,
      task_ids: decidedTaskIds
    },
    message:
      failedApprovalIds.length > 0
        ? `承認待ちを${decidedTaskIds.length}件${decision === "approved" ? "承認" : "却下"}しました（一部失敗あり）。`
        : `承認待ちを${decidedTaskIds.length}件${decision === "approved" ? "承認" : "却下"}しました。`,
    touchedTaskId: decidedTaskIds[0] ?? null
  };
}

async function runBulkRetryFailedCommandsCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  sessionId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, sessionId, intentJson } = args;
  const maxItemsRaw = typeof intentJson.maxItems === "number" ? intentJson.maxItems : Number.NaN;
  const maxItems = Number.isFinite(maxItemsRaw) ? Math.max(1, Math.min(20, Math.floor(maxItemsRaw))) : 5;
  const scope =
    intentJson.scope === "shared" || intentJson.scope === "personal" || intentJson.scope === "all" ? intentJson.scope : "current";

  let sessionIds: string[] | null = null;
  if (scope === "current") {
    sessionIds = [sessionId];
  } else if (scope === "shared" || scope === "personal") {
    const { data: sessions, error: sessionsError } = await supabase
      .from("chat_sessions")
      .select("id")
      .eq("org_id", orgId)
      .eq("scope", scope);
    if (sessionsError) {
      throw new Error(`対象セッション取得に失敗しました: ${sessionsError.message}`);
    }
    sessionIds = (sessions ?? []).map((row) => row.id as string);
  }

  let commandQuery = supabase
    .from("chat_commands")
    .select("id")
    .eq("org_id", orgId)
    .eq("execution_status", "failed")
    .order("created_at", { ascending: false })
    .limit(maxItems * 4);
  if (sessionIds && sessionIds.length > 0) {
    commandQuery = commandQuery.in("session_id", sessionIds);
  } else if (sessionIds && sessionIds.length === 0) {
    throw new Error("対象scopeに再実行候補がありません。");
  }

  const { data: commands, error: commandsError } = await commandQuery;
  if (commandsError) {
    throw new Error(`失敗コマンドの取得に失敗しました: ${commandsError.message}`);
  }
  const rows = commands ?? [];
  if (rows.length === 0) {
    throw new Error("失敗コマンドはありません。");
  }

  let createdCount = 0;
  let skippedPendingCount = 0;
  let skippedLimitCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    if (createdCount >= maxItems) break;
    try {
      const result = await createRetryConfirmationForFailedCommand({
        supabase,
        orgId,
        userId,
        commandId: row.id as string,
        skipCooldown: true
      });
      if (result.created) {
        createdCount += 1;
      } else if (result.reason === "already_pending") {
        skippedPendingCount += 1;
      } else if (result.reason === "pending_limit_reached") {
        skippedLimitCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      const message = error instanceof Error ? error.message : "unknown";
      console.error(`[CHAT_BULK_RETRY_FROM_COMMAND_FAILED] command_id=${row.id as string} ${message}`);
    }
  }

  if (createdCount === 0 && failedCount > 0) {
    throw new Error("再実行確認を作成できませんでした。");
  }

  return {
    executionRefType: "chat_command",
    executionRefId: null,
    result: {
      scope,
      requested_count: maxItems,
      created_count: createdCount,
      skipped_pending_count: skippedPendingCount,
      skipped_limit_count: skippedLimitCount,
      failed_count: failedCount
    },
    message: `再実行確認を${createdCount}件作成しました（pending重複:${skippedPendingCount} / 上限スキップ:${skippedLimitCount} / 失敗:${failedCount}）。`,
    touchedTaskId: null
  };
}

async function runQuickTopActionCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  sessionId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, sessionId, intentJson } = args;
  const action =
    intentJson.action === "request_approval" ||
    intentJson.action === "approve" ||
    intentJson.action === "reject" ||
    intentJson.action === "accept_proposal"
      ? intentJson.action
      : null;
  if (!action) {
    throw new Error("quick action が不正です。");
  }
  const target =
    intentJson.target === "approval" || intentJson.target === "proposal" || intentJson.target === "exception"
      ? intentJson.target
      : "auto";
  const indexRaw = typeof intentJson.index === "number" ? intentJson.index : Number.NaN;
  const index = Number.isFinite(indexRaw) ? Math.max(1, Math.min(3, Math.floor(indexRaw))) : 1;
  const offset = index - 1;
  const quickBase = {
    mode: "quick_top_action",
    index,
    target,
    requested_action: action
  };
  const buildQuickSkip = async (params: {
    taskId: string | null;
    reason: string;
    details?: Record<string, unknown>;
  }) => {
    if (params.taskId) {
      await appendTaskEvent({
        supabase,
        orgId,
        taskId: params.taskId,
        actorType: "user",
        actorId: userId,
        eventType: "CHAT_QUICK_ACTION_USED",
        payload: {
          ...quickBase,
          skipped: true,
          skip_reason: params.reason,
          ...params.details
        }
      });
    }
    return {
      executionRefType: "chat_command",
      executionRefId: null,
      result: {
        skipped: true,
        skip_reason: params.reason,
        quick_ref: {
          ...quickBase,
          ...params.details
        }
      },
      message: `クイック実行はスキップされました: ${params.reason}`,
      touchedTaskId: params.taskId
    };
  };

  const top = await getRecentTopCandidatesFromSession({ supabase, orgId, sessionId });
  if (!top) {
    throw new Error("直近のTOP候補が見つかりません。先に状況確認を実行してください。");
  }
  const ttlSecondsRaw = Number.parseInt(process.env.CHAT_STATUS_TOP_TTL_SECONDS ?? "600", 10);
  const ttlSeconds = Number.isNaN(ttlSecondsRaw) ? 600 : Math.max(60, Math.min(3600, ttlSecondsRaw));
  const generatedAtMs = top.generatedAt ? Date.parse(top.generatedAt) : Number.NaN;
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error("TOP候補の生成時刻が不明です。先に状況確認を再実行してください。");
  }
  const ageSeconds = Math.floor((Date.now() - generatedAtMs) / 1000);
  if (ageSeconds > ttlSeconds) {
    throw new Error(`TOP候補が古くなっています（${ageSeconds}s経過）。先に状況確認を再実行してください。`);
  }

  if (action === "accept_proposal") {
    const proposalId = (target === "proposal" || target === "auto" ? top.proposalIds : [])[offset];
    if (!proposalId) {
      throw new Error(`提案TOP${index} が見つかりません。`);
    }
    const accepted = await acceptProposalShared({
      supabase,
      orgId,
      userId,
      proposalId,
      decisionReason: "accepted_chat:quick_top_action",
      autoRequestApproval: true,
      source: "chat"
    });
    await appendTaskEvent({
      supabase,
      orgId,
      taskId: accepted.taskId,
      actorType: "user",
      actorId: userId,
      eventType: "CHAT_QUICK_ACTION_USED",
      payload: {
        ...quickBase,
        selected_candidate_type: "proposal",
        selected_candidate_id: proposalId,
        task_id: accepted.taskId,
        approval_id: accepted.approvalId
      }
    });
    return {
      executionRefType: "task",
      executionRefId: accepted.taskId,
      result: {
        action,
        index,
        quick_ref: {
          ...quickBase,
          selected_candidate_type: "proposal",
          selected_candidate_id: proposalId,
          generated_at: top.generatedAt,
          max_age_seconds: ttlSeconds
        },
        proposal_id: accepted.proposalId,
        task_id: accepted.taskId,
        approval_id: accepted.approvalId
      },
      message: `TOP候補 #${index} の提案を受け入れて承認依頼を作成しました。(/app/tasks/${accepted.taskId})`,
      touchedTaskId: accepted.taskId
    };
  }

  const candidateTaskId =
    target === "approval"
      ? top.approvalTaskIds[offset]
      : target === "exception"
        ? top.exceptionTaskIds[offset]
        : top.approvalTaskIds[offset] ?? top.exceptionTaskIds[offset];
  if (!candidateTaskId) {
    throw new Error(`TOP候補 #${index} のタスクが見つかりません。`);
  }

  if (action === "request_approval") {
    try {
      return await runRequestApprovalCommand({
        supabase,
        orgId,
        userId,
        sessionId,
        intentJson: { taskHint: candidateTaskId },
        quickRef: {
          ...quickBase,
          selected_candidate_type: target === "exception" ? "exception_task" : "approval_task",
          selected_candidate_id: candidateTaskId,
          generated_at: top.generatedAt,
          max_age_seconds: ttlSeconds
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request_approval_failed";
      if (message.includes("すでに承認待ち")) {
        return buildQuickSkip({
          taskId: candidateTaskId,
          reason: "approval_already_pending",
          details: {
            selected_candidate_type: target === "exception" ? "exception_task" : "approval_task",
            selected_candidate_id: candidateTaskId
          }
        });
      }
      throw error;
    }
  }

  const { data: pendingApprovalRow, error: pendingApprovalError } = await supabase
    .from("approvals")
    .select("id")
    .eq("org_id", orgId)
    .eq("task_id", candidateTaskId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingApprovalError) {
    throw new Error(`承認検索に失敗しました: ${pendingApprovalError.message}`);
  }
  if (!pendingApprovalRow?.id) {
    return buildQuickSkip({
      taskId: candidateTaskId,
      reason: "approval_not_pending",
      details: {
        selected_candidate_type: target === "exception" ? "exception_task" : "approval_task",
        selected_candidate_id: candidateTaskId
      }
    });
  }

  const decision = action === "approve" ? "approved" : "rejected";
  const decided = await decideApprovalShared({
    supabase,
    approvalId: pendingApprovalRow.id as string,
    decision,
    reason: "chat_quick_top_action",
    actorType: "user",
    actorId: userId,
    source: "chat",
    expectedOrgId: orgId
  });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: decided.taskId,
    actorType: "user",
    actorId: userId,
    eventType: "CHAT_QUICK_ACTION_USED",
    payload: {
      ...quickBase,
      selected_candidate_type: target === "exception" ? "exception_task" : "approval_task",
      selected_candidate_id: candidateTaskId,
      approval_id: decided.approvalId,
      decision: decided.approvalStatus
    }
  });

  return {
    executionRefType: "approval",
    executionRefId: decided.approvalId,
    result: {
      action,
      index,
      quick_ref: {
        ...quickBase,
        selected_candidate_type: target === "exception" ? "exception_task" : "approval_task",
        selected_candidate_id: candidateTaskId,
        generated_at: top.generatedAt,
        max_age_seconds: ttlSeconds
      },
      approval_id: decided.approvalId,
      task_id: decided.taskId,
      decision: decided.approvalStatus
    },
    message:
      action === "approve"
        ? `TOP候補 #${index} を承認しました。(/app/tasks/${decided.taskId})`
        : `TOP候補 #${index} を却下しました。(/app/tasks/${decided.taskId})`,
    touchedTaskId: decided.taskId
  };
}

async function runAcceptProposalCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const { supabase, orgId, userId, intentJson } = args;
  const proposalHint = typeof intentJson.proposalHint === "string" ? intentJson.proposalHint : null;
  const autoRequestApproval = intentJson.autoRequestApproval !== false;

  const proposal = await findProposalForChat({
    supabase,
    orgId,
    proposalHint
  });

  const accepted = await acceptProposalShared({
    supabase,
    orgId,
    userId,
    proposalId: proposal.id,
    decisionReason: "accepted_chat:auto_accept_from_chat",
    autoRequestApproval,
    source: "chat"
  });

  return {
    executionRefType: "task",
    executionRefId: accepted.taskId,
    result: {
      proposal_id: accepted.proposalId,
      task_id: accepted.taskId,
      approval_id: accepted.approvalId,
      auto_request_approval: autoRequestApproval
    },
    message: autoRequestApproval
      ? `提案を受け入れて承認依頼まで作成しました: ${accepted.proposalTitle} (/app/tasks/${accepted.taskId})`
      : `提案を受け入れてタスク化しました: ${accepted.proposalTitle} (/app/tasks/${accepted.taskId})`,
    touchedTaskId: accepted.taskId
  };
}

async function runPlannerFromChatCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const maxRaw =
    typeof args.intentJson.maxProposals === "number"
      ? args.intentJson.maxProposals
      : Number.parseInt(String(args.intentJson.maxProposals ?? "2"), 10);
  const maxProposals = Number.isNaN(maxRaw) ? 2 : Math.max(1, Math.min(5, maxRaw));

  const result = await runPlanner({
    supabase: args.supabase,
    orgId: args.orgId,
    actorUserId: args.userId,
    maxProposals
  });

  return {
    executionRefType: "planner_run",
    executionRefId: result.plannerRunId,
    result: {
      planner_run_id: result.plannerRunId,
      status: result.status,
      created_proposals: result.createdProposals,
      considered_signals: result.consideredSignals,
      requested_max_proposals: maxProposals
    },
    message: `プランナーを実行しました。提案作成: ${result.createdProposals}件 / run: /app/planner`,
    touchedTaskId: null
  };
}

async function runWorkflowFromChatCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  sessionId: string;
  intentJson: Record<string, unknown>;
}) {
  let taskHint = typeof args.intentJson.taskHint === "string" ? args.intentJson.taskHint : null;
  if (!taskHint) {
    taskHint = await getRecentTaskHintFromSession({
      supabase: args.supabase,
      orgId: args.orgId,
      sessionId: args.sessionId
    });
  }
  const task = await findTaskForChat({
    supabase: args.supabase,
    orgId: args.orgId,
    taskHint
  });

  const { data: taskRow, error: taskError } = await args.supabase
    .from("tasks")
    .select("workflow_template_id")
    .eq("id", task.id)
    .eq("org_id", args.orgId)
    .maybeSingle();
  if (taskError) {
    throw new Error(`タスク情報取得に失敗しました: ${taskError.message}`);
  }
  const templateId = (taskRow?.workflow_template_id as string | null) ?? null;
  if (!templateId) {
    throw new Error("このタスクには workflow template が設定されていません。/app/tasks で設定してください。");
  }

  const started = await startWorkflowRun({
    supabase: args.supabase,
    orgId: args.orgId,
    taskId: task.id,
    templateId,
    actorId: args.userId
  });

  return {
    executionRefType: "workflow_run",
    executionRefId: started.workflowRunId,
    result: {
      workflow_run_id: started.workflowRunId,
      task_id: task.id,
      task_title: task.title
    },
    message: `ワークフロー実行を開始しました: ${task.title} (/app/workflows/runs/${started.workflowRunId})`,
    touchedTaskId: task.id
  };
}

async function runBulkRetryFailedWorkflowsCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  intentJson: Record<string, unknown>;
}) {
  const maxItemsRaw =
    typeof args.intentJson.maxItems === "number"
      ? args.intentJson.maxItems
      : Number.parseInt(String(args.intentJson.maxItems ?? "3"), 10);
  const maxItems = Number.isNaN(maxItemsRaw) ? 3 : Math.max(1, Math.min(10, maxItemsRaw));

  const { data: runs, error: runsError } = await args.supabase
    .from("workflow_runs")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("status", "failed")
    .order("finished_at", { ascending: false })
    .limit(maxItems);
  if (runsError) {
    throw new Error(`失敗workflow run取得に失敗しました: ${runsError.message}`);
  }

  const targets = (runs ?? []).map((row) => row.id as string).filter(Boolean);
  if (targets.length === 0) {
    return {
      executionRefType: "workflow_run",
      executionRefId: null,
      result: {
        retried: 0,
        failed: 0,
        target_count: 0
      },
      message: "再試行対象の失敗workflow runはありません。",
      touchedTaskId: null
    };
  }

  let successCount = 0;
  let failCount = 0;
  for (const workflowRunId of targets) {
    try {
      await retryFailedWorkflowRun({
        supabase: args.supabase,
        orgId: args.orgId,
        workflowRunId,
        actorId: args.userId
      });
      successCount += 1;
    } catch {
      failCount += 1;
    }
  }

  return {
    executionRefType: "workflow_run",
    executionRefId: targets[0] ?? null,
    result: {
      retried: successCount,
      failed: failCount,
      target_count: targets.length,
      workflow_run_ids: targets
    },
    message: `失敗workflow runを再試行しました: success=${successCount}, failed=${failCount} (/app/workflows/runs)`,
    touchedTaskId: null
  };
}

async function executeIntentCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  sessionId: string;
  intentType: string;
  intentJson: Record<string, unknown>;
}) {
  if (args.intentType === "create_task") {
    return runCreateTaskCommand(args);
  }
  if (args.intentType === "request_approval") {
    return runRequestApprovalCommand(args);
  }
  if (args.intentType === "accept_proposal") {
    return runAcceptProposalCommand(args);
  }
  if (args.intentType === "decide_approval") {
    return runDecideApprovalCommand(args);
  }
  if (args.intentType === "bulk_decide_approvals") {
    return runBulkDecideApprovalsCommand(args);
  }
  if (args.intentType === "bulk_retry_failed_commands") {
    return runBulkRetryFailedCommandsCommand(args);
  }
  if (args.intentType === "quick_top_action") {
    return runQuickTopActionCommand(args);
  }
  if (args.intentType === "execute_action") {
    return runExecuteActionCommand(args);
  }
  if (args.intentType === "run_planner") {
    return runPlannerFromChatCommand(args);
  }
  if (args.intentType === "run_workflow") {
    return runWorkflowFromChatCommand(args);
  }
  if (args.intentType === "update_case_status") {
    return runUpdateCaseStatusCommand(args);
  }
  if (args.intentType === "update_case_owner_self") {
    return runUpdateCaseOwnerSelfCommand(args);
  }
  if (args.intentType === "update_case_due") {
    return runUpdateCaseDueCommand(args);
  }
  if (args.intentType === "bulk_retry_failed_workflows") {
    return runBulkRetryFailedWorkflowsCommand(args);
  }
  throw new Error("この実行タイプは未対応です。");
}

async function postMessage(scope: ChatScope, formData: FormData, channelId?: string | null) {
  const body = String(formData.get("body") ?? "").trim();
  if (!body) {
    redirect(withError(scope, "メッセージを入力してください。", channelId));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const mentions = extractMentions(body);
  const aiMentioned = hasAiMention(body);

  const session = await getOrCreateChatSession({
    supabase,
    orgId,
    scope,
    userId,
    channelId
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
        scope,
        mentions,
        ai_mentioned: aiMentioned
      }
    })
    .select("id")
    .single();

  if (userMsgError) {
    redirect(withError(scope, `メッセージ保存に失敗しました: ${userMsgError.message}`, channelId));
  }

  await supabase
    .from("chat_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", session.id)
    .eq("org_id", orgId);

  if (!aiMentioned) {
    revalidatePath(pathForScope(scope, channelId));
    redirect(withOk(scope, "メッセージを送信しました。AIに依頼する場合は @AI を付けてください。", channelId));
  }

  const aiBody = stripAiMention(body);
  if (!aiBody) {
    revalidatePath(pathForScope(scope, channelId));
    redirect(withError(scope, "@AI の後に依頼内容を入力してください。", channelId));
  }

  const intent = parseChatIntent(aiBody);
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
    redirect(withError(scope, `意図解析保存に失敗しました: ${intentError.message}`, channelId));
  }

  if (intent.intentType === "status_query") {
    const taskHint = typeof intent.plan.taskHint === "string" ? intent.plan.taskHint : null;
    const focus =
      intent.plan.focus === "approval" ||
      intent.plan.focus === "proposal" ||
      intent.plan.focus === "exception" ||
      intent.plan.focus === "incident"
        ? intent.plan.focus
        : "overview";
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
          task_id: task.id,
          focus
        }
      });
    } else {
      const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const threeDaysAgoIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const [
        { count: taskCount },
        { count: pendingApprovalCount },
        { count: staleApprovalCount },
        { count: actionFailCount },
        { count: pendingProposalCount },
        { count: blockedProposalCount },
        { count: openIncidentCount },
        { count: failedWorkflowCount },
        { count: blockedTaskCount }
      ] = await Promise.all([
        supabase.from("tasks").select("id", { count: "exact", head: true }).eq("org_id", orgId),
        supabase.from("approvals").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "pending"),
        supabase
          .from("approvals")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "pending")
          .lt("created_at", threeDaysAgoIso),
        supabase
          .from("actions")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "failed")
          .gte("created_at", sevenDaysAgoIso),
        supabase.from("task_proposals").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "proposed"),
        supabase
          .from("task_proposals")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "proposed")
          .eq("policy_status", "block"),
        supabase.from("org_incidents").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "open"),
        supabase
          .from("workflow_runs")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "failed")
          .gte("created_at", sevenDaysAgoIso),
        supabase
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "ready_for_approval")
      ]);
      const [
        { data: topPendingApprovals },
        { data: topProposals },
        { data: topFailedActions },
        { data: topIncidents }
      ] = await Promise.all([
        supabase
          .from("approvals")
          .select("id, task_id, created_at")
          .eq("org_id", orgId)
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(3),
        supabase
          .from("task_proposals")
          .select("id, title, priority_score, policy_status")
          .eq("org_id", orgId)
          .eq("status", "proposed")
          .order("priority_score", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(3),
        supabase
          .from("actions")
          .select("id, task_id, provider, action_type, created_at")
          .eq("org_id", orgId)
          .eq("status", "failed")
          .gte("created_at", sevenDaysAgoIso)
          .order("created_at", { ascending: false })
          .limit(3),
        supabase
          .from("org_incidents")
          .select("id, severity, reason, created_at")
          .eq("org_id", orgId)
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(3)
      ]);

      const taskIdsForTitles = Array.from(
        new Set([
          ...((topPendingApprovals ?? []).map((row) => row.task_id as string).filter(Boolean) as string[]),
          ...((topFailedActions ?? []).map((row) => row.task_id as string).filter(Boolean) as string[])
        ])
      );
      let taskTitleById = new Map<string, string>();
      if (taskIdsForTitles.length > 0) {
        const { data: taskRows } = await supabase
          .from("tasks")
          .select("id, title")
          .eq("org_id", orgId)
          .in("id", taskIdsForTitles);
        taskTitleById = new Map((taskRows ?? []).map((row) => [row.id as string, row.title as string]));
      }

      const topApprovalsText =
        (topPendingApprovals ?? []).length > 0
          ? (topPendingApprovals ?? [])
              .map((row, idx) => {
                const taskId = row.task_id as string;
                return `${idx + 1}) ${taskTitleById.get(taskId) ?? taskId} -> /app/tasks/${taskId}`;
              })
              .join("\n")
          : "該当なし";
      const topProposalsText =
        (topProposals ?? []).length > 0
          ? (topProposals ?? [])
              .map((row, idx) => {
                const title = (row.title as string) ?? (row.id as string);
                const priority = Number(row.priority_score ?? 0);
                return `${idx + 1}) ${title} (priority:${priority}) -> /app/proposals`;
              })
              .join("\n")
          : "該当なし";
      const topExceptionsText =
        (topFailedActions ?? []).length > 0
          ? (topFailedActions ?? [])
              .map((row, idx) => {
                const taskId = row.task_id as string;
                const label = taskTitleById.get(taskId) ?? taskId;
                return `${idx + 1}) ${label} (${String(row.provider)}/${String(row.action_type)}) -> /app/tasks/${taskId}`;
              })
              .join("\n")
          : "該当なし";
      const topIncidentsText =
        (topIncidents ?? []).length > 0
          ? (topIncidents ?? [])
              .map((row, idx) => `${idx + 1}) [${String(row.severity).toUpperCase()}] ${String(row.reason)} -> /app/governance/incidents`)
              .join("\n")
          : "該当なし";

      const overviewText =
        `現状サマリ:\n` +
        `- タスク総数: ${taskCount ?? 0}\n` +
        `- 承認待ち: ${pendingApprovalCount ?? 0} (SLA超過目安: ${staleApprovalCount ?? 0})\n` +
        `- 提案待ち: ${pendingProposalCount ?? 0} (policy block: ${blockedProposalCount ?? 0})\n` +
        `- 7日失敗アクション: ${actionFailCount ?? 0}\n` +
        `- 7日失敗ワークフロー: ${failedWorkflowCount ?? 0}\n` +
        `- open incidents: ${openIncidentCount ?? 0}\n` +
        `次アクション:\n` +
        `1) 例外キュー確認: /app/operations/exceptions\n` +
        `2) 承認キュー確認: /app/approvals\n` +
        `3) 提案キュー確認: /app/proposals\n` +
        `優先対象TOP3:\n` +
        `- 承認待ち:\n${topApprovalsText}\n` +
        `- 提案待ち:\n${topProposalsText}\n` +
        `- 失敗アクション:\n${topExceptionsText}`;

      const approvalText =
        `承認キュー状況:\n` +
        `- pending approvals: ${pendingApprovalCount ?? 0}\n` +
        `- 3日超 pending approvals: ${staleApprovalCount ?? 0}\n` +
        `- ready_for_approval tasks: ${blockedTaskCount ?? 0}\n` +
        `- 7日失敗アクション: ${actionFailCount ?? 0}\n` +
        `次アクション:\n` +
        `1) 承認を処理: /app/approvals\n` +
        `2) Slack再通知: /app/approvals\n` +
        `3) タスク詳細確認: /app/tasks\n` +
        `優先承認TOP3:\n${topApprovalsText}`;

      const proposalText =
        `提案キュー状況:\n` +
        `- proposed: ${pendingProposalCount ?? 0}\n` +
        `- policy block proposals: ${blockedProposalCount ?? 0}\n` +
        `- open incidents: ${openIncidentCount ?? 0}\n` +
        `- 承認待ち: ${pendingApprovalCount ?? 0}\n` +
        `次アクション:\n` +
        `1) 提案を採択/却下: /app/proposals\n` +
        `2) プランナー実行: /app/planner\n` +
        `3) policy block を精査: /app/proposals?policy_status=block\n` +
        `優先提案TOP3:\n${topProposalsText}`;

      const exceptionText =
        `例外キュー状況:\n` +
        `- 7日失敗アクション: ${actionFailCount ?? 0}\n` +
        `- 7日失敗ワークフロー: ${failedWorkflowCount ?? 0}\n` +
        `- 3日超 pending approvals: ${staleApprovalCount ?? 0}\n` +
        `- policy block proposals: ${blockedProposalCount ?? 0}\n` +
        `次アクション:\n` +
        `1) 例外トリアージ: /app/operations/exceptions\n` +
        `2) チャット失敗監査: /app/chat/audit?status=failed\n` +
        `3) ガバナンス提案確認: /app/governance/recommendations\n` +
        `優先例外TOP3:\n${topExceptionsText}`;

      const incidentText =
        `インシデント状況:\n` +
        `- open incidents: ${openIncidentCount ?? 0}\n` +
        `- 7日失敗アクション: ${actionFailCount ?? 0}\n` +
        `- 7日失敗ワークフロー: ${failedWorkflowCount ?? 0}\n` +
        `- 提案待ち(policy block): ${blockedProposalCount ?? 0}\n` +
        `次アクション:\n` +
        `1) インシデント対応: /app/governance/incidents\n` +
        `2) 例外キュー確認: /app/operations/exceptions\n` +
        `3) 自律設定確認: /app/governance\n` +
        `Open Incident TOP3:\n${topIncidentsText}`;

      const bodyText =
        focus === "approval"
          ? approvalText
          : focus === "proposal"
            ? proposalText
            : focus === "exception"
              ? exceptionText
              : focus === "incident"
                ? incidentText
                : overviewText;

      await addSystemMessage({
        supabase,
        orgId,
        sessionId: session.id,
        bodyText,
        metadata: {
          intent_id: intentRow.id,
          intent_type: intent.intentType,
          focus,
          status_top_candidates: {
            generated_at: new Date().toISOString(),
            approval_task_ids: (topPendingApprovals ?? []).map((row) => row.task_id as string),
            proposal_ids: (topProposals ?? []).map((row) => row.id as string),
            exception_task_ids: (topFailedActions ?? []).map((row) => row.task_id as string),
            incident_ids: (topIncidents ?? []).map((row) => row.id as string)
          }
        }
      });
    }

    revalidatePath(pathForScope(scope, channelId));
    redirect(withOk(scope, "状況を要約しました。", channelId));
  }

  if (intent.requiresConfirmation) {
    try {
      await assertConfirmationGuardrails({
        supabase,
        orgId,
        sessionId: session.id
      });
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
      redirect(withError(scope, message, channelId));
    }

    revalidatePath(pathForScope(scope, channelId));
    redirect(withOk(scope, "実行確認を作成しました。", channelId));
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

  revalidatePath(pathForScope(scope, channelId));
  redirect(withOk(scope, "回答を返しました。", channelId));
}

export async function postSharedMessage(formData: FormData) {
  return postMessage("shared", formData);
}

export async function postPersonalMessage(formData: FormData) {
  return postMessage("personal", formData);
}

export async function postChannelMessage(formData: FormData) {
  const channelId = String(formData.get("channel_id") ?? "").trim();
  if (!channelId) {
    redirect("/app/chat/channels?error=channel_id%20is%20required");
  }
  return postMessage("channel", formData, channelId);
}

export async function expireStaleChatConfirmations(formData: FormData) {
  const scope = normalizeScope(String(formData.get("scope") ?? "shared").trim());
  const channelId = String(formData.get("channel_id") ?? "").trim() || null;
  const returnTo = String(formData.get("return_to") ?? "").trim();
  const redirectPath = returnTo || pathForScope(scope, channelId);

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  let expiredCount = 0;
  try {
    const result = await expirePendingChatConfirmations({
      supabase,
      orgId,
      actorUserId: userId,
      source: "manual"
    });
    expiredCount = result.expiredCount;
  } catch (error) {
    const message = error instanceof Error ? error.message : "期限切れ更新に失敗しました。";
    redirect(`${redirectPath}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/app/chat/shared");
  revalidatePath("/app/chat/me");
  revalidatePath("/app/chat/channels");
  revalidatePath("/app/chat/audit");
  redirect(`${redirectPath}?ok=${encodeURIComponent(`期限切れ確認を${expiredCount}件更新しました。`)}`);
}

async function createRetryConfirmationForFailedCommand(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
  commandId: string;
  skipCooldown?: boolean;
}) {
  const { supabase, orgId, userId, commandId, skipCooldown = false } = args;
  const { data: command, error: commandError } = await supabase
    .from("chat_commands")
    .select("id, session_id, intent_id, execution_status")
    .eq("id", commandId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (commandError) {
    throw new Error(`再実行対象の取得に失敗しました: ${commandError.message}`);
  }
  if (!command) {
    throw new Error("再実行対象が見つかりません。");
  }
  if (command.execution_status !== "failed") {
    throw new Error("failed のコマンドのみ再実行できます。");
  }

  const sessionId = command.session_id as string;
  const intentId = command.intent_id as string;

  const { data: existingPending, error: pendingLookupError } = await supabase
    .from("chat_confirmations")
    .select("id")
    .eq("org_id", orgId)
    .eq("session_id", sessionId)
    .eq("intent_id", intentId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (pendingLookupError) {
    throw new Error(`既存確認の確認に失敗しました: ${pendingLookupError.message}`);
  }
  if (existingPending?.id) {
    return { created: false, reason: "already_pending" as const };
  }

  if (!skipCooldown) {
    await assertConfirmationGuardrails({
      supabase,
      orgId,
      sessionId
    });
  } else {
    const pendingLimit = Number(process.env.CHAT_CONFIRMATION_PENDING_LIMIT ?? "5");
    const limit = Number.isFinite(pendingLimit) && pendingLimit > 0 ? pendingLimit : 5;
    const { count, error: countError } = await supabase
      .from("chat_confirmations")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("session_id", sessionId)
      .eq("status", "pending");
    if (countError) {
      throw new Error(`確認キュー件数の取得に失敗しました: ${countError.message}`);
    }
    if ((count ?? 0) >= limit) {
      return { created: false, reason: "pending_limit_reached" as const };
    }
  }

  const { expiresAt } = await saveIntentConfirmation({
    supabase,
    orgId,
    sessionId,
    intentId
  });

  await addSystemMessage({
    supabase,
    orgId,
    sessionId,
    bodyText: "失敗コマンドの再実行確認を作成しました。Yes で再実行します。",
    metadata: {
      retried_from_command_id: command.id,
      intent_id: command.intent_id,
      requires_confirmation: true,
      expires_at: expiresAt,
      requested_by: userId
    }
  });

  return { created: true, reason: "created" as const };
}

export async function retryChatCommand(formData: FormData) {
  const commandId = String(formData.get("command_id") ?? "").trim();
  const scope = normalizeScope(String(formData.get("scope") ?? "shared").trim());
  const channelId = String(formData.get("channel_id") ?? "").trim() || null;
  const returnTo = String(formData.get("return_to") ?? "").trim();
  const redirectPath = returnTo || pathForScope(scope, channelId);

  if (!commandId) {
    redirect(`${redirectPath}?error=${encodeURIComponent("command_id がありません。")}`);
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  try {
    await createRetryConfirmationForFailedCommand({
      supabase,
      orgId,
      userId,
      commandId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "再実行確認を作成できませんでした。";
    redirect(`${redirectPath}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(pathForScope(scope, channelId));
  revalidatePath("/app/chat/audit");
  redirect(`${redirectPath}?ok=${encodeURIComponent("再実行確認を作成しました。")}`);
}

export async function bulkRetryFailedCommands(formData: FormData) {
  const returnTo = String(formData.get("return_to") ?? "/app/chat/audit").trim() || "/app/chat/audit";
  const maxItemsRaw = Number.parseInt(String(formData.get("max_items") ?? "5"), 10);
  const maxItems = Number.isNaN(maxItemsRaw) ? 5 : Math.max(1, Math.min(20, maxItemsRaw));
  const scope = String(formData.get("scope") ?? "").trim();
  const intentType = String(formData.get("intent_type") ?? "").trim();

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  let commandQuery = supabase
    .from("chat_commands")
    .select("id, session_id, intent_id, created_at")
    .eq("org_id", orgId)
    .eq("execution_status", "failed")
    .order("created_at", { ascending: false })
    .limit(maxItems * 4);

  if (scope === "shared" || scope === "personal") {
    const { data: sessions, error: sessionsError } = await supabase
      .from("chat_sessions")
      .select("id")
      .eq("org_id", orgId)
      .eq("scope", scope);
    if (sessionsError) {
      redirect(`${returnTo}?error=${encodeURIComponent(`対象セッション取得に失敗しました: ${sessionsError.message}`)}`);
    }
    const sessionIds = (sessions ?? []).map((row) => row.id as string);
    if (sessionIds.length === 0) {
      redirect(`${returnTo}?ok=${encodeURIComponent("対象scopeに再実行候補がありません。")}`);
    }
    commandQuery = commandQuery.in("session_id", sessionIds);
  }

  if (intentType && intentType !== "all") {
    const { data: intents, error: intentsError } = await supabase
      .from("chat_intents")
      .select("id")
      .eq("org_id", orgId)
      .eq("intent_type", intentType)
      .order("created_at", { ascending: false })
      .limit(500);
    if (intentsError) {
      redirect(`${returnTo}?error=${encodeURIComponent(`intent取得に失敗しました: ${intentsError.message}`)}`);
    }
    const intentIds = (intents ?? []).map((row) => row.id as string);
    if (intentIds.length === 0) {
      redirect(`${returnTo}?ok=${encodeURIComponent(`intent=${intentType} の失敗コマンドはありません。`)}`);
    }
    commandQuery = commandQuery.in("intent_id", intentIds);
  }

  const { data: commands, error: commandsError } = await commandQuery;
  if (commandsError) {
    redirect(`${returnTo}?error=${encodeURIComponent(`失敗コマンドの取得に失敗しました: ${commandsError.message}`)}`);
  }

  const rows = commands ?? [];
  if (rows.length === 0) {
    redirect(`${returnTo}?ok=${encodeURIComponent("失敗コマンドはありません。")}`);
  }

  let createdCount = 0;
  let skippedPendingCount = 0;
  let skippedLimitCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    if (createdCount >= maxItems) break;
    try {
      const result = await createRetryConfirmationForFailedCommand({
        supabase,
        orgId,
        userId,
        commandId: row.id as string,
        skipCooldown: true
      });
      if (result.created) {
        createdCount += 1;
      } else if (result.reason === "already_pending") {
        skippedPendingCount += 1;
      } else if (result.reason === "pending_limit_reached") {
        skippedLimitCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      const message = error instanceof Error ? error.message : "unknown";
      console.error(`[CHAT_BULK_RETRY_FAILED] command_id=${row.id as string} ${message}`);
    }
  }

  revalidatePath("/app/chat/shared");
  revalidatePath("/app/chat/me");
  revalidatePath("/app/chat/channels");
  revalidatePath("/app/chat/audit");
  revalidatePath("/app");

  const intentSuffix = intentType && intentType !== "all" ? ` intent=${intentType}` : "";
  const message = `再実行確認を${createdCount}件作成しました${intentSuffix}（pending重複:${skippedPendingCount} / 上限スキップ:${skippedLimitCount} / 失敗:${failedCount}）。`;
  redirect(`${returnTo}?ok=${encodeURIComponent(message)}`);
}

export async function confirmChatCommand(formData: FormData) {
  const confirmationId = String(formData.get("confirmation_id") ?? "").trim();
  const scope = normalizeScope(String(formData.get("scope") ?? "shared").trim());
  const channelId = String(formData.get("channel_id") ?? "").trim() || null;
  const decision = String(formData.get("decision") ?? "").trim();

  if (!confirmationId || (decision !== "confirmed" && decision !== "declined")) {
    redirect(withError(scope, "確認リクエストが不正です。", channelId));
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
    redirect(withError(scope, `確認情報の取得に失敗しました: ${confirmationError.message}`, channelId));
  }

  if (confirmation.status !== "pending") {
    redirect(withError(scope, "この確認はすでに処理済みです。", channelId));
  }

  const expiresAt = new Date(confirmation.expires_at as string).getTime();
  if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
    await supabase
      .from("chat_confirmations")
      .update({ status: "expired", decided_at: new Date().toISOString(), decided_by: userId })
      .eq("id", confirmationId)
      .eq("org_id", orgId);
    redirect(withError(scope, "確認期限が切れています。もう一度依頼してください。", channelId));
  }

  const { data: intent, error: intentError } = await supabase
    .from("chat_intents")
    .select("id, intent_type, intent_json")
    .eq("id", confirmation.intent_id as string)
    .eq("org_id", orgId)
    .single();
  if (intentError) {
    redirect(withError(scope, `意図情報の取得に失敗しました: ${intentError.message}`, channelId));
  }

  const latestOpenIncident = await getLatestOpenIncident({ supabase, orgId });
  if (latestOpenIncident && isBlockedByIncident(intent.intent_type as string)) {
    await supabase
      .from("chat_confirmations")
      .update({
        status: "declined",
        decided_at: new Date().toISOString(),
        decided_by: userId
      })
      .eq("id", confirmationId)
      .eq("org_id", orgId);

    await addSystemMessage({
      supabase,
      orgId,
      sessionId: confirmation.session_id as string,
      bodyText: `インシデントモード中のため、この操作は停止されました。severity=${latestOpenIncident.severity} reason=${latestOpenIncident.reason}`,
      metadata: {
        confirmation_id: confirmationId,
        intent_id: intent.id,
        blocked_by_incident: true,
        incident_id: latestOpenIncident.id
      }
    });

    revalidatePath(pathForScope(scope, channelId));
    redirect(withError(scope, "インシデントモード中のため、この実行はブロックされました。", channelId));
  }

  try {
    await assertUserDailyExecutionLimit({
      supabase,
      orgId,
      userId,
      intentType: intent.intent_type as string
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "実行上限チェックに失敗しました。";
    await supabase
      .from("chat_confirmations")
      .update({
        status: "declined",
        decided_at: new Date().toISOString(),
        decided_by: userId
      })
      .eq("id", confirmationId)
      .eq("org_id", orgId);
    await addSystemMessage({
      supabase,
      orgId,
      sessionId: confirmation.session_id as string,
      bodyText: `実行は制限されました: ${message}`,
      metadata: {
        confirmation_id: confirmationId,
        intent_id: intent.id,
        blocked_by_daily_limit: true
      }
    });
    revalidatePath(pathForScope(scope, channelId));
    redirect(withError(scope, message, channelId));
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
    await appendAiExecutionLog({
      supabase,
      orgId,
      triggeredByUserId: userId,
      sessionId: confirmation.session_id as string,
      sessionScope: scope,
      channelId,
      intentType: intent.intent_type as string,
      executionStatus: "declined",
      source: "chat",
      summaryText: "User declined command confirmation",
      metadata: { confirmation_id: confirmationId, decision: "declined" },
      createdAt: nowIso,
      finishedAt: nowIso
    });
    revalidatePath(pathForScope(scope, channelId));
    redirect(withOk(scope, "実行をキャンセルしました。", channelId));
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
    redirect(withError(scope, `コマンド生成に失敗しました: ${commandError.message}`, channelId));
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
      sessionId: confirmation.session_id as string,
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

    await appendAiExecutionLog({
      supabase,
      orgId,
      triggeredByUserId: userId,
      sessionId: confirmation.session_id as string,
      sessionScope: scope,
      channelId,
      intentType: intent.intent_type as string,
      executionStatus: "done",
      executionRefType: executed.executionRefType,
      executionRefId: executed.executionRefId,
      source: "chat",
      summaryText: executed.message,
      metadata: { command_id: command.id, confirmation_id: confirmationId, result: executed.result },
      createdAt: nowIso,
      finishedAt: new Date().toISOString()
    });

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
        execution_ref_type: executed.executionRefType,
        quick_ref: asObject(executed.result).quick_ref ?? null
      }
    });

    revalidatePath(pathForScope(scope, channelId));
    revalidatePath("/app/tasks");
    revalidatePath("/app/approvals");
    revalidatePath("/app/planner");
    revalidatePath("/app/proposals");
    revalidatePath("/app/cases");
    if (executed.executionRefType === "case" && typeof executed.executionRefId === "string" && executed.executionRefId.length > 0) {
      revalidatePath(`/app/cases/${executed.executionRefId}`);
    }
    revalidatePath("/app/workflows/runs");
    revalidatePath("/app/chat/channels");
    if (executed.touchedTaskId) {
      revalidatePath(`/app/tasks/${executed.touchedTaskId}`);
    }

    revalidatePath("/app/executions");
    redirect(withOk(scope, "実行が完了しました。", channelId));
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

    await appendAiExecutionLog({
      supabase,
      orgId,
      triggeredByUserId: userId,
      sessionId: confirmation.session_id as string,
      sessionScope: scope,
      channelId,
      intentType: intent.intent_type as string,
      executionStatus: "failed",
      source: "chat",
      summaryText: `実行失敗: ${message}`,
      metadata: { command_id: command.id, confirmation_id: confirmationId, error: message },
      createdAt: nowIso,
      finishedAt: new Date().toISOString()
    });

    revalidatePath(pathForScope(scope, channelId));
    revalidatePath("/app/executions");
    redirect(withError(scope, message, channelId));
  }
}
