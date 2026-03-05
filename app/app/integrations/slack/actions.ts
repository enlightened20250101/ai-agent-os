"use server";

import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { getSlackConfigForRuntime, postSlackMessage } from "@/lib/slack/client";

function withMessage(type: "ok" | "error", message: string) {
  return `/app/integrations/slack?${type}=${encodeURIComponent(message)}`;
}

export async function sendSlackTestMessage() {
  await requireOrgContext();
  const cfg = getSlackConfigForRuntime();
  if (!cfg.botToken || !cfg.approvalChannelId) {
    redirect(withMessage("error", "SLACK_BOT_TOKEN or SLACK_APPROVAL_CHANNEL_ID is missing."));
  }

  try {
    await postSlackMessage({
      channel: cfg.approvalChannelId,
      text: "AI Agent OS Slack integration test message.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*AI Agent OS*\nSlack integration test message delivered successfully."
          }
        }
      ]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Slack error.";
    redirect(withMessage("error", message));
  }

  redirect(withMessage("ok", "Test message sent successfully."));
}
