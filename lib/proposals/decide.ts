import type { SupabaseClient } from "@supabase/supabase-js";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { postApprovalRequestToSlack } from "@/lib/slack/approvals";

type ProposalAction = {
  provider: "google";
  action_type: "send_email";
  to: string;
  subject: string;
  body_text: string;
};

function parseProposalActions(payload: unknown): ProposalAction[] {
  if (!Array.isArray(payload)) return [];
  return payload
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
    .filter((value): value is ProposalAction => value !== null);
}

function parseStringList(payload: unknown) {
  return Array.isArray(payload) ? payload.filter((item): item is string => typeof item === "string") : [];
}

export async function acceptProposalShared(args: {
  supabase: SupabaseClient;
  orgId: string;
  userId: string;
  proposalId: string;
  decisionReason: string;
  autoRequestApproval: boolean;
  source: "ui" | "chat";
}) {
  const { supabase, orgId, userId, proposalId, decisionReason, autoRequestApproval, source } = args;

  const { data: proposal, error: proposalError } = await supabase
    .from("task_proposals")
    .select("id, title, rationale, proposed_actions_json, risks_json, policy_status, policy_reasons, status, source")
    .eq("id", proposalId)
    .eq("org_id", orgId)
    .single();
  if (proposalError) {
    throw new Error(`提案の取得に失敗しました: ${proposalError.message}`);
  }
  if (proposal.status !== "proposed") {
    throw new Error("この提案はすでに判断済みです。");
  }
  if (proposal.policy_status === "block") {
    throw new Error("policy_status=block の提案は受け入れできません。");
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
    throw new Error(`優先エージェント取得に失敗しました: ${preferredAgentError.message}`);
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
      throw new Error(`代替エージェント取得に失敗しました: ${firstActiveAgentError.message}`);
    }
    agentId = firstActiveAgent?.id as string | undefined;
  }
  if (!agentId) {
    throw new Error("提案変換に利用できる有効なエージェントがありません。");
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
    throw new Error(`提案からタスク作成に失敗しました: ${taskError.message}`);
  }

  const proposedActions = parseProposalActions(proposal.proposed_actions_json);
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
        source: source === "chat" ? "proposal_accept_chat" : "proposal_accept"
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
        proposed_actions: proposedActions,
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
      evaluated_action: proposedActions[0] ?? null,
      source: source === "chat" ? "proposal_accept_chat" : "proposal_accept",
      proposal_id: proposal.id
    }
  });

  const nowIso = new Date().toISOString();
  const { error: updateProposalError } = await supabase
    .from("task_proposals")
    .update({
      status: "accepted",
      decided_at: nowIso,
      decided_by: userId,
      decision_reason: decisionReason
    })
    .eq("id", proposalId)
    .eq("org_id", orgId);
  if (updateProposalError) {
    throw new Error(`提案ステータス更新に失敗しました: ${updateProposalError.message}`);
  }

  const { error: proposalEventError } = await supabase.from("proposal_events").insert({
    org_id: orgId,
    proposal_id: proposalId,
    event_type: "PROPOSAL_ACCEPTED",
    payload_json: {
      task_id: createdTask.id,
      decided_by: userId,
      decision_reason: decisionReason,
      decision_reason_code: decisionReason.split(":")[0],
      source
    }
  });
  if (proposalEventError) {
    throw new Error(`提案イベント記録に失敗しました: ${proposalEventError.message}`);
  }

  let approvalId: string | null = null;
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
      throw new Error(`承認依頼作成に失敗しました: ${approvalError.message}`);
    }
    approvalId = approval.id as string;

    await appendTaskEvent({
      supabase,
      orgId,
      taskId: createdTask.id as string,
      actorId: userId,
      eventType: "APPROVAL_REQUESTED",
      payload: {
        approval_id: approval.id,
        source: source === "chat" ? "proposal_accept_chat" : "proposal_accept"
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
            slack_ts: slackMessage.ts,
            source: source === "chat" ? "proposal_accept_chat" : "proposal_accept"
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack承認投稿に失敗しました。";
      console.error(`[PROPOSAL_ACCEPT_SLACK_APPROVAL_POST_FAILED] task_id=${createdTask.id as string} ${message}`);
    }
  }

  return {
    proposalId: proposal.id as string,
    proposalTitle: proposal.title as string,
    taskId: createdTask.id as string,
    taskStatus: createdTask.status as string,
    approvalId
  };
}
