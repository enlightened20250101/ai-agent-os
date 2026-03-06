import { NextResponse } from "next/server";
import { APP_LOCALE_COOKIE } from "@/lib/i18n/locale";

function safeReturnTo(raw: string | null) {
  const value = (raw ?? "").trim();
  if (value.startsWith("/app") || value.startsWith("/login") || value === "/") {
    return value;
  }
  return "/app";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const locale = url.searchParams.get("locale") === "en" ? "en" : "ja";
  const returnTo = safeReturnTo(url.searchParams.get("return_to"));

  const response = NextResponse.redirect(new URL(returnTo, url.origin));
  response.cookies.set(APP_LOCALE_COOKIE, locale, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365
  });
  return response;
}
