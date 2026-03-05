"use server";

import { redirect } from "next/navigation";
import { upsertConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { requireOrgContext } from "@/lib/org/context";
import { postSlackMessage } from "@/lib/slack/client";
import { createClient } from "@/lib/supabase/server";

function withMessage(type: "ok" | "error", message: string) {
  return `/app/integrations/slack?${type}=${encodeURIComponent(message)}`;
}

export async function saveSlackConnector(formData: FormData) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const botToken = String(formData.get("bot_token") ?? "").trim();
  const signingSecret = String(formData.get("signing_secret") ?? "").trim();
  const approvalChannelId = String(formData.get("approval_channel_id") ?? "").trim();
  const workspaceId = String(formData.get("workspace_id") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();

  if (!botToken || !signingSecret || !approvalChannelId) {
    redirect(withMessage("error", "bot_token, signing_secret, approval_channel_id are required."));
  }

  try {
    await upsertConnectorAccount({
      supabase,
      orgId,
      provider: "slack",
      externalAccountId: workspaceId || "workspace",
      displayName: displayName || null,
      secrets: {
        bot_token: botToken,
        signing_secret: signingSecret,
        approval_channel_id: approvalChannelId
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save Slack connector.";
    redirect(withMessage("error", message));
  }

  redirect(withMessage("ok", "Slack connector saved."));
}

export async function sendSlackTestMessage() {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const cfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!cfg.botToken || !cfg.approvalChannelId) {
    redirect(withMessage("error", "Slack connector is not configured (DB or env fallback)."));
  }

  try {
    await postSlackMessage({
      botToken: cfg.botToken,
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
