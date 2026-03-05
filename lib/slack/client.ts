type SlackBlock = Record<string, unknown>;

type PostSlackMessageArgs = {
  botToken: string;
  channel: string;
  text: string;
  blocks?: SlackBlock[];
};

export async function postSlackMessage(args: PostSlackMessageArgs): Promise<{
  ts: string;
  channel: string;
  permalink?: string;
}> {
  if (!args.botToken) {
    throw new Error("Missing SLACK_BOT_TOKEN.");
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.botToken}`
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

  let permalink: string | undefined;
  try {
    const permalinkResponse = await fetch("https://slack.com/api/chat.getPermalink", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.botToken}`
      },
      body: JSON.stringify({
        channel: payload.channel,
        message_ts: payload.ts
      })
    });
    if (permalinkResponse.ok) {
      const permalinkPayload = (await permalinkResponse.json()) as {
        ok?: boolean;
        permalink?: string;
      };
      if (permalinkPayload.ok && typeof permalinkPayload.permalink === "string") {
        permalink = permalinkPayload.permalink;
      }
    }
  } catch {
    // Permalink is best-effort; message post result remains successful.
  }

  return {
    ts: payload.ts,
    channel: payload.channel,
    permalink
  };
}
