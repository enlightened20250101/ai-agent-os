"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { APP_LOCALE_COOKIE } from "@/lib/i18n/locale";

export async function updateLocale(formData: FormData) {
  const locale = String(formData.get("locale") ?? "ja").trim();
  const returnTo = String(formData.get("return_to") ?? "/app/settings").trim() || "/app/settings";
  const safeLocale = locale === "en" ? "en" : "ja";

  const store = await cookies();
  store.set(APP_LOCALE_COOKIE, safeLocale, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365
  });

  redirect(returnTo.includes("?") ? `${returnTo}&ok=language_updated` : `${returnTo}?ok=language_updated`);
}
