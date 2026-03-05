import { NextResponse } from "next/server";
import { getConnectorAccount, upsertConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import {
  exchangeGoogleCodeForTokens,
  getGoogleRedirectUri,
  getGoogleSenderEmail,
  getNormalizedAppBaseUrl,
  verifyGoogleOAuthState
} from "@/lib/google/oauth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function integrationsUrl(appBaseUrl: string, params: Record<string, string>) {
  const url = new URL("/app/integrations/google", appBaseUrl);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url;
}

function createErrorId() {
  return `gcb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function failureRedirect(
  appBaseUrl: string,
  args: { error: string; description: string; errorId: string; step: string; context?: Record<string, unknown> }
) {
  console.error("[GOOGLE_OAUTH_CALLBACK_ERROR]", {
    errorId: args.errorId,
    step: args.step,
    ...args.context
  });
  return NextResponse.redirect(
    integrationsUrl(appBaseUrl, {
      error: args.error,
      error_description: args.description,
      error_id: args.errorId
    })
  );
}

export async function GET(request: Request) {
  const appBaseUrl = getNormalizedAppBaseUrl();

  if (process.env.E2E_MODE === "1") {
    return NextResponse.redirect(integrationsUrl(appBaseUrl, { success: "1", message: "oauth_noop_e2e" }));
  }

  const url = new URL(request.url);
  const redirectUri = getGoogleRedirectUri();
  console.info("[GOOGLE_OAUTH_CALLBACK_HIT]", {
    appBaseUrl,
    redirectUri
  });

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return failureRedirect(appBaseUrl, {
      error: "google_oauth_error",
      description: oauthError.slice(0, 120),
      errorId: createErrorId(),
      step: "google_oauth_error_param"
    });
  }

  const code = url.searchParams.get("code") ?? "";
  const stateToken = url.searchParams.get("state") ?? "";
  if (!code || !stateToken) {
    return failureRedirect(appBaseUrl, {
      error: "missing_callback_params",
      description: "Missing code or state.",
      errorId: createErrorId(),
      step: "callback_params"
    });
  }

  const parsedState = verifyGoogleOAuthState({ token: stateToken });
  if (!parsedState) {
    return failureRedirect(appBaseUrl, {
      error: "invalid_state",
      description: "OAuth state validation failed.",
      errorId: createErrorId(),
      step: "state_signature_verify",
      context: { hasState: Boolean(stateToken) }
    });
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (user.id !== parsedState.userId) {
    return failureRedirect(appBaseUrl, {
      error: "user_mismatch",
      description: "OAuth user does not match current session.",
      errorId: createErrorId(),
      step: "session_user_match",
      context: {
        stateUserPresent: Boolean(parsedState.userId),
        sessionUserPresent: Boolean(user.id),
        noncePresent: Boolean(parsedState.nonce)
      }
    });
  }

  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("org_id", parsedState.orgId)
    .limit(1)
    .maybeSingle();
  if (membershipError || !membership) {
    return failureRedirect(appBaseUrl, {
      error: "org_membership_failed",
      description: "Org membership check failed.",
      errorId: createErrorId(),
      step: "org_membership_lookup",
      context: {
        orgIdPresent: Boolean(parsedState.orgId),
        userIdPresent: Boolean(parsedState.userId),
        noncePresent: Boolean(parsedState.nonce),
        code: membershipError?.code ?? null
      }
    });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: stateRow, error: consumeError } = await admin
    .from("google_oauth_states")
    .update({ consumed_at: nowIso })
    .eq("nonce", parsedState.nonce)
    .eq("org_id", parsedState.orgId)
    .eq("user_id", parsedState.userId)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .select("id, nonce")
    .maybeSingle();

  if (consumeError || !stateRow) {
    return failureRedirect(appBaseUrl, {
      error: "state_not_found_or_expired",
      description: "OAuth state expired or already consumed.",
      errorId: createErrorId(),
      step: "state_lookup_consume",
      context: {
        orgIdPresent: Boolean(parsedState.orgId),
        userIdPresent: Boolean(parsedState.userId),
        noncePresent: Boolean(parsedState.nonce),
        code: consumeError?.code ?? null
      }
    });
  }

  let accessToken = "";
  let refreshToken: string | null = null;
  try {
    const exchanged = await exchangeGoogleCodeForTokens(code);
    accessToken = exchanged.accessToken;
    refreshToken = exchanged.refreshToken;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token exchange failed.";
      return failureRedirect(appBaseUrl, {
        error: "oauth_callback_failed",
        description: "Failed during Google token exchange.",
        errorId: createErrorId(),
      step: "token_exchange",
      context: {
        orgIdPresent: Boolean(parsedState.orgId),
        userIdPresent: Boolean(parsedState.userId),
        noncePresent: Boolean(parsedState.nonce),
        message: message.slice(0, 160)
      }
    });
  }

  let senderEmail = "";
  try {
    senderEmail = await getGoogleSenderEmail(accessToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gmail profile lookup failed.";
    return failureRedirect(appBaseUrl, {
      error: "oauth_callback_failed",
      description: "Failed to detect sender email from Gmail profile.",
      errorId: createErrorId(),
      step: "gmail_profile",
      context: {
        orgIdPresent: Boolean(parsedState.orgId),
        userIdPresent: Boolean(parsedState.userId),
        noncePresent: Boolean(parsedState.nonce),
        message: message.slice(0, 160)
      }
    });
  }

  const existingConnector = await getConnectorAccount({
    supabase: admin,
    orgId: parsedState.orgId,
    provider: "google"
  });
  const existingRefreshToken =
    typeof existingConnector?.secrets_json?.refresh_token === "string"
      ? (existingConnector.secrets_json.refresh_token as string)
      : null;
  const refreshTokenToStore = refreshToken ?? existingRefreshToken;

  if (!refreshTokenToStore) {
    return failureRedirect(appBaseUrl, {
      error: "missing_refresh_token",
      description: "No refresh token returned. Reconnect with consent.",
      errorId: createErrorId(),
      step: "refresh_token_check",
      context: {
        orgIdPresent: Boolean(parsedState.orgId),
        userIdPresent: Boolean(parsedState.userId),
        noncePresent: Boolean(parsedState.nonce)
      }
    });
  }

  try {
    await upsertConnectorAccount({
      supabase: admin,
      orgId: parsedState.orgId,
      provider: "google",
      externalAccountId: senderEmail,
      displayName: "Google Gmail",
      secrets: {
        refresh_token: refreshTokenToStore,
        sender_email: senderEmail
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connector upsert failed.";
    return failureRedirect(appBaseUrl, {
      error: "oauth_callback_failed",
      description: "Failed to save Google connector.",
      errorId: createErrorId(),
      step: "db_upsert",
      context: {
        orgIdPresent: Boolean(parsedState.orgId),
        userIdPresent: Boolean(parsedState.userId),
        noncePresent: Boolean(parsedState.nonce),
        message: message.slice(0, 160)
      }
    });
  }

  return NextResponse.redirect(integrationsUrl(appBaseUrl, { success: "1" }));
}
