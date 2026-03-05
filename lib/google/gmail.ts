type SendEmailArgs = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderEmail: string;
  to: string;
  subject: string;
  bodyText: string;
};

type SendEmailResult = {
  messageId: string;
  stubbed: boolean;
};

function toBase64Url(input: string) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function toBase64WithLineWrap(input: string) {
  const b64 = Buffer.from(input, "utf8").toString("base64");
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function encodeHeaderValue(value: string) {
  // RFC 2047 encoded-word for non-ASCII-safe subject headers.
  if (/^[\x20-\x7E]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function exchangeRefreshTokenForAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const params = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
    grant_type: "refresh_token"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("Google token exchange returned no access token.");
  }

  return payload.access_token;
}

export async function sendEmailWithGmail(args: SendEmailArgs): Promise<SendEmailResult> {
  if (process.env.E2E_MODE === "1") {
    return {
      messageId: "stub-gmail-message-id",
      stubbed: true
    };
  }

  if (!args.clientId || !args.clientSecret || !args.refreshToken || !args.senderEmail) {
    throw new Error("Google connector credentials are missing.");
  }
  if (!isValidEmail(args.senderEmail)) {
    throw new Error("Google sender email is invalid.");
  }
  if (!isValidEmail(args.to)) {
    throw new Error("Draft recipient email is invalid.");
  }
  const accessToken = await exchangeRefreshTokenForAccessToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    refreshToken: args.refreshToken
  });

  const rawMessage = [
    `From: ${args.senderEmail}`,
    `To: ${args.to}`,
    `Subject: ${encodeHeaderValue(args.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    toBase64WithLineWrap(args.bodyText)
  ].join("\r\n");

  const encodedMessage = toBase64Url(rawMessage);
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      raw: encodedMessage
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail send failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const payload = (await response.json()) as { id?: string };
  if (!payload.id) {
    throw new Error("Gmail send succeeded but no message id was returned.");
  }

  return {
    messageId: payload.id,
    stubbed: false
  };
}
