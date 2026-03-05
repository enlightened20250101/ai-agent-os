import crypto from "node:crypto";
import { getSupabaseServiceRoleKey } from "@/lib/supabase/env";

type OAuthStatePayload = {
  orgId: string;
  userId: string;
  nonce: string;
  exp: number;
};

function getGoogleOAuthClientConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured.");
  }
  return { clientId, clientSecret };
}

export function getGoogleOAuthRedirectUri() {
  const appBaseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${appBaseUrl}/api/google/callback`;
}

function signStatePayload(payloadEncoded: string) {
  const secret = getSupabaseServiceRoleKey();
  return crypto.createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
}

export function createGoogleOAuthState(args: { orgId: string; userId: string; ttlSec?: number }) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + (args.ttlSec ?? 60 * 10);
  const payload: OAuthStatePayload = {
    orgId: args.orgId,
    userId: args.userId,
    nonce,
    exp
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signStatePayload(encoded);
  return {
    token: `${encoded}.${sig}`,
    nonce,
    exp
  };
}

export function verifyGoogleOAuthState(args: { token: string }) {
  const [encoded, providedSig] = args.token.split(".");
  if (!encoded || !providedSig) {
    return null;
  }
  const expectedSig = signStatePayload(encoded);
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  const providedBuf = Buffer.from(providedSig, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return null;
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    return null;
  }

  if (!payload.orgId || !payload.userId || !payload.nonce || !payload.exp) {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

export function buildGoogleOAuthAuthUrl(state: string) {
  const { clientId } = getGoogleOAuthClientConfig();
  const redirectUri = getGoogleOAuthRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCodeForTokens(code: string) {
  const { clientId, clientSecret } = getGoogleOAuthClientConfig();
  const redirectUri = getGoogleOAuthRedirectUri();

  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token exchange failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!payload.access_token) {
    throw new Error("OAuth token exchange returned no access token.");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null
  };
}

export async function getGoogleSenderEmail(accessToken: string) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail profile lookup failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const payload = (await response.json()) as { emailAddress?: string };
  const email = payload.emailAddress?.trim();
  if (!email) {
    throw new Error("Gmail profile response did not include emailAddress.");
  }
  return email;
}
