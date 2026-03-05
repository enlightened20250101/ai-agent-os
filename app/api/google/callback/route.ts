import { NextResponse } from "next/server";
import { getConnectorAccount, upsertConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import { exchangeGoogleCodeForTokens, getGoogleSenderEmail, verifyGoogleOAuthState } from "@/lib/google/oauth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function integrationsUrl(request: Request, params: Record<string, string>) {
  const url = new URL("/app/integrations/google", request.url);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url;
}

export async function GET(request: Request) {
  if (process.env.E2E_MODE === "1") {
    return NextResponse.redirect(integrationsUrl(request, { success: "1", message: "oauth_noop_e2e" }));
  }

  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      integrationsUrl(request, {
        error: "google_oauth_error",
        error_description: oauthError.slice(0, 120)
      })
    );
  }

  const code = url.searchParams.get("code") ?? "";
  const stateToken = url.searchParams.get("state") ?? "";
  if (!code || !stateToken) {
    return NextResponse.redirect(
      integrationsUrl(request, {
        error: "missing_callback_params",
        error_description: "Missing code or state."
      })
    );
  }

  const parsedState = verifyGoogleOAuthState({ token: stateToken });
  if (!parsedState) {
    console.error("[GOOGLE_OAUTH_CALLBACK_STATE_INVALID]", {
      hasState: Boolean(stateToken)
    });
    return NextResponse.redirect(
      integrationsUrl(request, {
        error: "invalid_state",
        error_description: "OAuth state validation failed."
      })
    );
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (user.id !== parsedState.userId) {
    console.error("[GOOGLE_OAUTH_CALLBACK_USER_MISMATCH]", {
      stateUserPresent: Boolean(parsedState.userId),
      sessionUserPresent: Boolean(user.id),
      noncePresent: Boolean(parsedState.nonce)
    });
    return NextResponse.redirect(
      integrationsUrl(request, {
        error: "user_mismatch",
        error_description: "OAuth user does not match current session."
      })
    );
  }

  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("org_id", parsedState.orgId)
    .limit(1)
    .maybeSingle();
  if (membershipError || !membership) {
    console.error("[GOOGLE_OAUTH_CALLBACK_ORG_MEMBERSHIP_FAILED]", {
      orgIdPresent: Boolean(parsedState.orgId),
      userIdPresent: Boolean(parsedState.userId),
      noncePresent: Boolean(parsedState.nonce),
      code: membershipError?.code ?? null
    });
    return NextResponse.redirect(
      integrationsUrl(request, {
        error: "org_membership_failed",
        error_description: "Org membership check failed."
      })
    );
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
    console.error("[GOOGLE_OAUTH_CALLBACK_STATE_CONSUME_FAILED]", {
      orgIdPresent: Boolean(parsedState.orgId),
      userIdPresent: Boolean(parsedState.userId),
      noncePresent: Boolean(parsedState.nonce),
      code: consumeError?.code ?? null
    });
    return NextResponse.redirect(
      integrationsUrl(request, {
        error: "state_not_found_or_expired",
        error_description: "OAuth state expired or already consumed."
      })
    );
  }

  try {
    const { accessToken, refreshToken } = await exchangeGoogleCodeForTokens(code);
    const senderEmail = await getGoogleSenderEmail(accessToken);
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
      return NextResponse.redirect(
        integrationsUrl(request, {
          error: "missing_refresh_token",
          error_description: "No refresh token returned. Reconnect with consent."
        })
      );
    }

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

    return NextResponse.redirect(integrationsUrl(request, { success: "1" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth callback failed.";
    console.error("[GOOGLE_OAUTH_CALLBACK_FAILED]", {
      orgIdPresent: Boolean(parsedState.orgId),
      userIdPresent: Boolean(parsedState.userId),
      noncePresent: Boolean(parsedState.nonce),
      message: message.slice(0, 160)
    });
    return NextResponse.redirect(
      integrationsUrl(request, {
        error: "oauth_callback_failed",
        error_description: "Failed to connect Google account."
      })
    );
  }
}
