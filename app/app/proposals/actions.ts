"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { postApprovalRequestToSlack } from "@/lib/slack/approvals";
import { createClient } from "@/lib/supabase/server";

function toError(message: string) {
  return `/app/proposals?error=${encodeURIComponent(message)}`;
}

function toOk(message: string) {
  return `/app/proposals?ok=${encodeURIComponent(message)}`;
}

function normalizeReasonCode(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  return value.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 64);
}

function composeDecisionReason(codeRaw: string, noteRaw: string) {
  const code = normalizeReasonCode(codeRaw) || "unspecified";
  const note = noteRaw.trim().replace(/\s+/g, " ").slice(0, 180);
  return note ? `${code}:${note}` : code;
}

function parseProposalDraft(payload: unknown): {
  proposedActions: ProposalAction[];
  risks: string[];
} {
  const actions = Array.isArray(payload)
    ? payload
        .map((item) => {
          if (typeof item !== "object" || item === null) return null;
          const row = item as Record<string, unknown>;
          if (
            row.provider !== "google" ||
            row.action_type !== "send_email" ||
            typeof row.to !== "string" ||
            typeof row.subject !== "string" ||
            typeof row.body_text !== "string"
          ) {
            return null;
          }
          return {
            provider: "google" as const,
            action_type: "send_email" as const,
            to: row.to,
            subject: row.subject,
            body_text: row.body_text
          };
        })
        .filter((v): v is ProposalAction => v !== null)
    : [];

  return {
    proposedActions: actions,
    risks: []
  };
}

type ProposalAction = {
  provider: "google";
  action_type: "send_email";
  to: string;
  subject: string;
  body_text: string;
};

function parseStringList(payload: unknown) {
  return Array.isArray(payload) ? payload.filter((item): item is string => typeof item === "string") : [];
}

function isMissingColumnError(message: string, columnName: string) {
  return (
    message.includes(`Could not find the '${columnName}' column`) ||
    message.includes(`column task_proposals.${columnName} does not exist`)
  );
}

export async function acceptProposal(formData: FormData) {
  const proposalId = String(formData.get("proposal_id") ?? "").trim();
  const decisionReasonCode = String(formData.get("decision_reason_code") ?? "").trim();
  const decisionReason = composeDecisionReason(decisionReasonCode || "accepted_manual", "");
  const autoRequestApproval = String(formData.get("auto_request_approval") ?? "") === "1";
  if (!proposalId) {
    redirect(toError("proposal_id がありません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: proposal, error: proposalError } = await supabase
    .from("task_proposals")
    .select(
      "id, title, rationale, proposed_actions_json, risks_json, policy_status, policy_reasons, status, source"
    )
    .eq("id", proposalId)
    .eq("org_id", orgId)
    .single();
  if (proposalError) {
    redirect(toError(`提案の取得に失敗しました: ${proposalError.message}`));
  }
  if (proposal.status !== "proposed") {
    redirect(toError("この提案はすでに判断済みです。"));
  }
  if (proposal.policy_status === "block") {
    redirect(toError("policy_status=block の提案は受け入れできません。"));
  }

  const { data: preferredAgent, error: preferredAgentError } = await supabase
    .from("agents")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .eq("role_key", "accounting")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (preferredAgentError) {
    redirect(toError(`優先エージェント取得に失敗しました: ${preferredAgentError.message}`));
  }

  let agentId = preferredAgent?.id as string | undefined;
  if (!agentId) {
    const { data: firstActiveAgent, error: firstActiveAgentError } = await supabase
      .from("agents")
      .select("id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstActiveAgentError) {
      redirect(toError(`代替エージェント取得に失敗しました: ${firstActiveAgentError.message}`));
    }
    agentId = firstActiveAgent?.id as string | undefined;
  }

  if (!agentId) {
    redirect(toError("提案変換に利用できる有効なエージェントがありません。"));
  }

  const taskStatus = proposal.policy_status === "block" ? "draft" : "ready_for_approval";
  const { data: createdTask, error: taskError } = await supabase
    .from("tasks")
    .insert({
      org_id: orgId,
      created_by_user_id: userId,
      agent_id: agentId,
      title: proposal.title,
      input_text: proposal.rationale,
      status: taskStatus
    })
    .select("id, status")
    .single();

  if (taskError) {
    redirect(toError(`提案からタスク作成に失敗しました: ${taskError.message}`));
  }

  const parsedActions = parseProposalDraft(proposal.proposed_actions_json).proposedActions;
  const risks = parseStringList(proposal.risks_json);
  const policyReasons = parseStringList(proposal.policy_reasons);

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: createdTask.id as string,
    actorId: userId,
    eventType: "TASK_CREATED",
    payload: {
      changed_fields: {
        title: proposal.title,
        status: createdTask.status,
        source: "proposal_accept"
      },
      proposal_id: proposal.id
    }
  });

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: createdTask.id as string,
    actorType: "system",
    actorId: null,
    eventType: "MODEL_INFERRED",
    payload: {
      model: "planner_proposal",
      latency_ms: 0,
      output: {
        summary: proposal.title,
        proposed_actions: parsedActions,
        risks
      },
      source: proposal.source,
      proposal_id: proposal.id
    }
  });

  await appendTaskEvent({
    supabase,
    orgId,
    taskId: createdTask.id as string,
    actorType: "system",
    actorId: null,
    eventType: "POLICY_CHECKED",
    payload: {
      status: proposal.policy_status,
      reasons: policyReasons,
      evaluated_action: parsedActions[0] ?? null,
      source: "proposal_accept",
      proposal_id: proposal.id
    }
  });

  const nowIso = new Date().toISOString();
  let { error: updateProposalError } = await supabase
    .from("task_proposals")
    .update({
      status: "accepted",
      decided_at: nowIso,
      decided_by: userId,
      decision_reason: decisionReason
    })
    .eq("id", proposalId)
    .eq("org_id", orgId);
  if (updateProposalError && isMissingColumnError(updateProposalError.message, "decision_reason")) {
    const retry = await supabase
      .from("task_proposals")
      .update({
        status: "accepted",
        decided_at: nowIso,
        decided_by: userId
      })
      .eq("id", proposalId)
      .eq("org_id", orgId);
    updateProposalError = retry.error;
  }
  if (updateProposalError) {
    redirect(toError(`提案ステータス更新に失敗しました: ${updateProposalError.message}`));
  }

  const { error: proposalEventError } = await supabase.from("proposal_events").insert({
    org_id: orgId,
    proposal_id: proposalId,
    event_type: "PROPOSAL_ACCEPTED",
    payload_json: {
      task_id: createdTask.id,
      decided_by: userId,
      decision_reason: decisionReason,
      decision_reason_code: decisionReason.split(":")[0]
    }
  });
  if (proposalEventError) {
    redirect(toError(`提案イベント記録に失敗しました: ${proposalEventError.message}`));
  }

  if (autoRequestApproval && proposal.policy_status !== "block") {
    const { data: approval, error: approvalError } = await supabase
      .from("approvals")
      .insert({
        org_id: orgId,
        task_id: createdTask.id as string,
        requested_by: userId,
        status: "pending"
      })
      .select("id")
      .single();
    if (approvalError) {
      redirect(toError(`承認依頼作成に失敗しました: ${approvalError.message}`));
    }

    await appendTaskEvent({
      supabase,
      orgId,
      taskId: createdTask.id as string,
      actorId: userId,
      eventType: "APPROVAL_REQUESTED",
      payload: {
        approval_id: approval.id
      }
    });

    try {
      const slackMessage = await postApprovalRequestToSlack({
        supabase,
        orgId,
        approvalId: approval.id as string,
        taskId: createdTask.id as string,
        taskTitle: proposal.title as string,
        draftSummary: proposal.title as string,
        policyStatus: proposal.policy_status as string
      });
      if (slackMessage) {
        await appendTaskEvent({
          supabase,
          orgId,
          taskId: createdTask.id as string,
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
      console.error(`[PROPOSAL_ACCEPT_SLACK_APPROVAL_POST_FAILED] task_id=${createdTask.id as string} ${message}`);
    }
  }

  revalidatePath("/app/proposals");
  revalidatePath("/app/tasks");
  revalidatePath("/app/approvals");
  revalidatePath(`/app/tasks/${createdTask.id as string}`);
  redirect(
    `/app/tasks/${createdTask.id as string}?ok=${encodeURIComponent(
      autoRequestApproval && proposal.policy_status !== "block"
        ? "提案を受け入れて承認依頼まで作成しました。"
        : "提案を受け入れてタスクを作成しました。"
    )}`
  );
}

export async function rejectProposal(formData: FormData) {
  const proposalId = String(formData.get("proposal_id") ?? "").trim();
  const reasonCodeRaw = String(formData.get("decision_reason_code") ?? "").trim();
  const reasonNote = String(formData.get("reason_note") ?? "").trim();
  const reason = composeDecisionReason(reasonCodeRaw || "rejected_other", reasonNote);
  if (!proposalId) {
    redirect(toError("proposal_id がありません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  let { error: updateError } = await supabase
    .from("task_proposals")
    .update({
      status: "rejected",
      decided_at: nowIso,
      decided_by: userId,
      decision_reason: reason || "rejected_via_ui"
    })
    .eq("id", proposalId)
    .eq("org_id", orgId)
    .eq("status", "proposed");
  if (updateError && isMissingColumnError(updateError.message, "decision_reason")) {
    const retry = await supabase
      .from("task_proposals")
      .update({
        status: "rejected",
        decided_at: nowIso,
        decided_by: userId
      })
      .eq("id", proposalId)
      .eq("org_id", orgId)
      .eq("status", "proposed");
    updateError = retry.error;
  }
  if (updateError) {
    redirect(toError(`提案の却下に失敗しました: ${updateError.message}`));
  }

  const { error: eventError } = await supabase.from("proposal_events").insert({
    org_id: orgId,
    proposal_id: proposalId,
    event_type: "PROPOSAL_REJECTED",
    payload_json: {
      reason: reason || null,
      decided_by: userId,
      decision_reason: reason || "rejected_via_ui",
      decision_reason_code: reason.split(":")[0],
      decision_reason_note: reason.includes(":") ? reason.slice(reason.indexOf(":") + 1) : null
    }
  });
  if (eventError) {
    redirect(toError(`却下イベント記録に失敗しました: ${eventError.message}`));
  }

  revalidatePath("/app/proposals");
  redirect(toOk("提案を却下しました。"));
}

export async function bulkRejectProposals(formData: FormData) {
  const proposalIds = formData
    .getAll("proposal_ids")
    .map((item) => String(item).trim())
    .filter(Boolean);
  const reasonCodeRaw = String(formData.get("decision_reason_code") ?? "").trim();
  const reasonNote = String(formData.get("reason_note") ?? "").trim();
  const reason = composeDecisionReason(reasonCodeRaw || "rejected_other", reasonNote);

  if (proposalIds.length === 0) {
    redirect(toError("却下対象の提案が選択されていません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  let { data: rows, error: loadError } = await supabase
    .from("task_proposals")
    .select("id")
    .eq("org_id", orgId)
    .in("id", proposalIds)
    .eq("status", "proposed");
  if (loadError) {
    redirect(toError(`提案取得に失敗しました: ${loadError.message}`));
  }
  const targetIds = (rows ?? []).map((row) => row.id as string);
  if (targetIds.length === 0) {
    redirect(toError("却下可能な提案がありません。"));
  }

  let { error: updateError } = await supabase
    .from("task_proposals")
    .update({
      status: "rejected",
      decided_at: nowIso,
      decided_by: userId,
      decision_reason: reason
    })
    .eq("org_id", orgId)
    .in("id", targetIds)
    .eq("status", "proposed");
  if (updateError && isMissingColumnError(updateError.message, "decision_reason")) {
    const retry = await supabase
      .from("task_proposals")
      .update({
        status: "rejected",
        decided_at: nowIso,
        decided_by: userId
      })
      .eq("org_id", orgId)
      .in("id", targetIds)
      .eq("status", "proposed");
    updateError = retry.error;
  }
  if (updateError) {
    redirect(toError(`一括却下に失敗しました: ${updateError.message}`));
  }

  const eventRows = targetIds.map((proposalId) => ({
    org_id: orgId,
    proposal_id: proposalId,
    event_type: "PROPOSAL_REJECTED",
    payload_json: {
      reason,
      decided_by: userId,
      decision_reason: reason,
      decision_reason_code: reason.split(":")[0],
      decision_reason_note: reason.includes(":") ? reason.slice(reason.indexOf(":") + 1) : null,
      bulk: true
    }
  }));
  const { error: eventsError } = await supabase.from("proposal_events").insert(eventRows);
  if (eventsError) {
    redirect(toError(`一括却下イベント記録に失敗しました: ${eventsError.message}`));
  }

  revalidatePath("/app/proposals");
  redirect(toOk(`${targetIds.length}件の提案を却下しました。`));
}
