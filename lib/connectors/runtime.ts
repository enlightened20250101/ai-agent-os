import type { SupabaseClient } from "@supabase/supabase-js";
import { getConnectorAccount } from "@/lib/connectors/getConnectorAccount";

export type SlackRuntimeConfig = {
  botToken: string;
  signingSecret: string;
  approvalChannelId: string;
  alertChannelId: string;
  source: "db" | "env" | "none";
};

export type GoogleRuntimeConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderEmail: string;
  source: "db" | "env" | "none";
};

function envSlackConfig(): SlackRuntimeConfig {
  const botToken = process.env.SLACK_BOT_TOKEN ?? "";
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const approvalChannelId = process.env.SLACK_APPROVAL_CHANNEL_ID ?? "";
  const alertChannelId = process.env.SLACK_ALERTS_CHANNEL_ID ?? "";
  if (botToken && signingSecret && approvalChannelId) {
    return { botToken, signingSecret, approvalChannelId, alertChannelId, source: "env" };
  }
  return { botToken: "", signingSecret: "", approvalChannelId: "", alertChannelId: "", source: "none" };
}

function envGoogleConfig(): GoogleRuntimeConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? "";
  const senderEmail = process.env.GOOGLE_SENDER_EMAIL ?? "";
  if (clientId && clientSecret && refreshToken && senderEmail) {
    return { clientId, clientSecret, refreshToken, senderEmail, source: "env" };
  }
  return { clientId: "", clientSecret: "", refreshToken: "", senderEmail: "", source: "none" };
}

export async function resolveSlackRuntimeConfig(args: {
  supabase: SupabaseClient;
  orgId: string;
}): Promise<SlackRuntimeConfig> {
  const connector = await getConnectorAccount({
    supabase: args.supabase,
    orgId: args.orgId,
    provider: "slack"
  });
  if (connector) {
    const secrets = connector.secrets_json;
    const botToken = typeof secrets.bot_token === "string" ? secrets.bot_token : "";
    const signingSecret = typeof secrets.signing_secret === "string" ? secrets.signing_secret : "";
    const approvalChannelId =
      typeof secrets.approval_channel_id === "string" ? secrets.approval_channel_id : "";
    const alertChannelId = typeof secrets.alert_channel_id === "string" ? secrets.alert_channel_id : "";

    if (botToken && signingSecret && approvalChannelId) {
      return { botToken, signingSecret, approvalChannelId, alertChannelId, source: "db" };
    }
  }
  return envSlackConfig();
}

export async function resolveGoogleRuntimeConfig(args: {
  supabase: SupabaseClient;
  orgId: string;
}): Promise<GoogleRuntimeConfig> {
  const connector = await getConnectorAccount({
    supabase: args.supabase,
    orgId: args.orgId,
    provider: "google"
  });
  if (connector) {
    const secrets = connector.secrets_json;
    const refreshToken = typeof secrets.refresh_token === "string" ? secrets.refresh_token : "";
    const senderEmail =
      typeof secrets.sender_email === "string" && secrets.sender_email.length > 0
        ? secrets.sender_email
        : connector.external_account_id;
    const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
    if (clientId && clientSecret && refreshToken && senderEmail) {
      return { clientId, clientSecret, refreshToken, senderEmail, source: "db" };
    }
  }
  return envGoogleConfig();
}

export function getSlackEnvStatus() {
  const env = envSlackConfig();
  return {
    botToken: Boolean(env.botToken),
    signingSecret: Boolean(env.signingSecret),
    approvalChannelId: Boolean(env.approvalChannelId),
    alertChannelId: Boolean(env.alertChannelId)
  };
}

export function getGoogleEnvStatus() {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? "";
  const senderEmail = process.env.GOOGLE_SENDER_EMAIL ?? "";
  return {
    clientId: Boolean(clientId),
    clientSecret: Boolean(clientSecret),
    refreshToken: Boolean(refreshToken),
    senderEmail: Boolean(senderEmail)
  };
}
