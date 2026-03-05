type SlackBlock = Record<string, unknown>;

function getSlackConfig() {
  return {
    botToken: process.env.SLACK_BOT_TOKEN ?? "",
    approvalChannelId: process.env.SLACK_APPROVAL_CHANNEL_ID ?? "",
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? ""
  };
}

export function getSlackEnvStatus() {
  const cfg = getSlackConfig();
  return {
    botToken: Boolean(cfg.botToken),
    approvalChannelId: Boolean(cfg.approvalChannelId),
    signingSecret: Boolean(cfg.signingSecret)
  };
}

type PostSlackMessageArgs = {
  channel: string;
  text: string;
  blocks?: SlackBlock[];
};

export async function postSlackMessage(args: PostSlackMessageArgs): Promise<{
  ts: string;
  channel: string;
}> {
  const cfg = getSlackConfig();
  if (!cfg.botToken) {
    throw new Error("Missing SLACK_BOT_TOKEN.");
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.botToken}`
    },
    body: JSON.stringify({
      channel: args.channel,
      text: args.text,
      blocks: args.blocks
    })
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Slack API HTTP error ${response.status}: ${txt.slice(0, 500)}`);
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    error?: string;
    ts?: string;
    channel?: string;
  };
  if (!payload.ok || !payload.ts || !payload.channel) {
    throw new Error(`Slack API failed: ${payload.error ?? "unknown error"}`);
  }

  return {
    ts: payload.ts,
    channel: payload.channel
  };
}

export function getSlackConfigForRuntime() {
  return getSlackConfig();
}
