type SendEmailArgs = {
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

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function exchangeRefreshTokenForAccessToken() {
  const clientId = getRequiredEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getRequiredEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = getRequiredEnv("GOOGLE_REFRESH_TOKEN");

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
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

  const sender = getRequiredEnv("GOOGLE_SENDER_EMAIL");
  if (!isValidEmail(sender)) {
    throw new Error("GOOGLE_SENDER_EMAIL is invalid.");
  }
  if (!isValidEmail(args.to)) {
    throw new Error("Draft recipient email is invalid.");
  }
  const accessToken = await exchangeRefreshTokenForAccessToken();

  const rawMessage = [
    `From: ${sender}`,
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    args.bodyText
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
