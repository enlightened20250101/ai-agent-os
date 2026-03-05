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
  const alertChannelId = String(formData.get("alert_channel_id") ?? "").trim();
  const workspaceId = String(formData.get("workspace_id") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();

  if (!botToken || !signingSecret || !approvalChannelId) {
    redirect(withMessage("error", "bot_token, signing_secret, approval_channel_id は必須です。"));
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
        approval_channel_id: approvalChannelId,
        alert_channel_id: alertChannelId || null
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slackコネクタ保存に失敗しました。";
    redirect(withMessage("error", message));
  }

  redirect(withMessage("ok", "Slackコネクタを保存しました。"));
}

export async function sendSlackTestMessage() {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const cfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  if (!cfg.botToken || !cfg.approvalChannelId) {
    redirect(withMessage("error", "Slackコネクタが未設定です（DB または env フォールバック）。"));
  }

  try {
    await postSlackMessage({
      botToken: cfg.botToken,
      channel: cfg.approvalChannelId,
      text: "AI Agent OS Slack連携テストメッセージ",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*AI Agent OS*\nSlack連携のテストメッセージ送信に成功しました。"
          }
        }
      ]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なSlackエラーです。";
    redirect(withMessage("error", message));
  }

  redirect(withMessage("ok", "テストメッセージを送信しました。"));
}

export async function sendSlackOpsAlertTestMessage() {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const cfg = await resolveSlackRuntimeConfig({ supabase, orgId });
  const alertChannelId = cfg.alertChannelId || cfg.approvalChannelId;
  if (!cfg.botToken || !alertChannelId) {
    redirect(withMessage("error", "Slackコネクタが未設定です（alert/approval channel が必要）。"));
  }

  try {
    await postSlackMessage({
      botToken: cfg.botToken,
      channel: alertChannelId,
      text: "AI Agent OS Opsアラート疎通テスト",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*AI Agent OS Ops Alert Test*\n" +
              `org_id: ${orgId}\n` +
              "このメッセージは運用アラート経路の疎通確認です。"
          }
        }
      ]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なSlackエラーです。";
    redirect(withMessage("error", message));
  }

  redirect(withMessage("ok", "Opsアラート疎通テストを送信しました。"));
}
