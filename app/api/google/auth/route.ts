import { NextResponse } from "next/server";
import {
  buildGoogleOAuthAuthUrl,
  createGoogleOAuthState,
  getGoogleRedirectUri,
  getNormalizedAppBaseUrl
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

export async function GET(request: Request) {
  const appBaseUrl = getNormalizedAppBaseUrl();

  if (process.env.E2E_MODE === "1") {
    return NextResponse.redirect(integrationsUrl(appBaseUrl, { success: "1", message: "oauth_noop_e2e" }));
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("org_id")
    .order("created_at", { ascending: true })
    .limit(1);
  if (membershipError) {
    console.error("[GOOGLE_OAUTH_AUTH_MEMBERSHIP_LOOKUP_FAILED]", {
      userIdPresent: Boolean(user.id),
      code: membershipError.code ?? null
    });
    return NextResponse.redirect(
      integrationsUrl(appBaseUrl, {
        error: "membership_lookup_failed",
        error_description: "Failed to resolve org membership."
      })
    );
  }
  const orgId = (memberships?.[0]?.org_id as string | undefined) ?? null;
  if (!orgId) {
    return NextResponse.redirect(new URL("/app/onboarding", request.url));
  }

  try {
    const state = createGoogleOAuthState({ orgId, userId: user.id, ttlSec: 60 * 10 });
    const admin = createAdminClient();
    const { error: stateInsertError } = await admin.from("google_oauth_states").insert({
      org_id: orgId,
      user_id: user.id,
      nonce: state.nonce,
      expires_at: new Date(state.exp * 1000).toISOString()
    });

    if (stateInsertError) {
      console.error("[GOOGLE_OAUTH_AUTH_STATE_INSERT_FAILED]", {
        orgIdPresent: Boolean(orgId),
        userIdPresent: Boolean(user.id),
        noncePresent: Boolean(state.nonce),
        code: stateInsertError.code ?? null
      });
      return NextResponse.redirect(
        integrationsUrl(appBaseUrl, {
          error: "state_insert_failed",
          error_description: "Failed to initialize OAuth state."
        })
      );
    }

    const redirectUri = getGoogleRedirectUri();
    console.info("[GOOGLE_OAUTH_AUTH_START]", {
      appBaseUrl,
      redirectUri,
      orgIdPresent: Boolean(orgId),
      userIdPresent: Boolean(user.id)
    });

    const authUrl = buildGoogleOAuthAuthUrl(state.token);
    return NextResponse.redirect(authUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth initialization failed.";
    console.error("[GOOGLE_OAUTH_AUTH_INIT_FAILED]", {
      orgIdPresent: Boolean(orgId),
      userIdPresent: Boolean(user.id),
      message
    });
    return NextResponse.redirect(
      integrationsUrl(appBaseUrl, {
        error: "oauth_init_failed",
        error_description: "Google OAuth initialization failed."
      })
    );
  }
}
