import { cookies } from "next/headers";

export type AppLocale = "ja" | "en";

export const APP_LOCALE_COOKIE = "app_locale";

export async function getAppLocale(): Promise<AppLocale> {
  const store = await cookies();
  const value = store.get(APP_LOCALE_COOKIE)?.value;
  return value === "en" ? "en" : "ja";
}

export function isEnglish(locale: AppLocale) {
  return locale === "en";
}
