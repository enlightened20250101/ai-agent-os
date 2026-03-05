import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { createApprovalActionToken } from "@/lib/slack/actionToken";
import { postSlackMessage } from "@/lib/slack/client";

type PostApprovalToSlackArgs = {
  supabase: SupabaseClient;
  orgId: string;
  approvalId: string;
  taskId: string;
  taskTitle: string;
  draftSummary: string | null;
  policyStatus: string | null;
};

export async function postApprovalRequestToSlack(args: PostApprovalToSlackArgs): Promise<{
  channel: string;
  ts: string;
} | null> {
  const cfg = await resolveSlackRuntimeConfig({
    supabase: args.supabase,
    orgId: args.orgId
  });
  if (!cfg.botToken || !cfg.approvalChannelId || !cfg.signingSecret) {
    return null;
  }

  const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const taskUrl = `${appBaseUrl}/app/tasks/${args.taskId}`;

  const approveToken = createApprovalActionToken({
    signingSecret: cfg.signingSecret,
    approvalId: args.approvalId,
    decision: "approved"
  });
  const rejectToken = createApprovalActionToken({
    signingSecret: cfg.signingSecret,
    approvalId: args.approvalId,
    decision: "rejected"
  });

  const message = await postSlackMessage({
    botToken: cfg.botToken,
    channel: cfg.approvalChannelId,
    text: `Approval requested for task ${args.taskTitle}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Approval Request*\n*Task:* ${args.taskTitle}\n*Draft summary:* ${args.draftSummary ?? "(none)"}\n*Policy status:* ${args.policyStatus ?? "(none)"}\n*Task link:* ${taskUrl}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: "approval_approve",
            value: approveToken
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            action_id: "approval_reject",
            value: rejectToken
          }
        ]
      }
    ]
  });

  return message;
}
