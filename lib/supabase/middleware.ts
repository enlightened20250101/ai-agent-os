import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

type CookieToSet = {
  name: string;
  value: string;
  options?: CookieOptions;
};

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      }
    }
  });

  const {
    data: { user }
  } = await supabase.auth.getUser();

  const isAppPath = request.nextUrl.pathname.startsWith("/app");
  const isOnboardingPath = request.nextUrl.pathname === "/app/onboarding";
  const isAuthPath = request.nextUrl.pathname === "/login" || request.nextUrl.pathname === "/signup";

  if (isAppPath && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("redirectedFrom", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthPath && user) {
    const appUrl = request.nextUrl.clone();
    appUrl.pathname = "/app";
    appUrl.search = "";
    return NextResponse.redirect(appUrl);
  }

  if (isAppPath && user) {
    const { data: memberships, error } = await supabase.from("memberships").select("id").limit(1);

    if (!error) {
      const hasMembership = (memberships?.length ?? 0) > 0;

      if (!hasMembership && !isOnboardingPath) {
        const onboardingUrl = request.nextUrl.clone();
        onboardingUrl.pathname = "/app/onboarding";
        onboardingUrl.search = "";
        return NextResponse.redirect(onboardingUrl);
      }

      if (hasMembership && isOnboardingPath) {
        const appUrl = request.nextUrl.clone();
        appUrl.pathname = "/app";
        appUrl.search = "";
        return NextResponse.redirect(appUrl);
      }
    }
  }

  return response;
}
