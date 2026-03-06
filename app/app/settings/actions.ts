"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { APP_LOCALE_COOKIE } from "@/lib/i18n/locale";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function toHandle(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

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

export async function updateProfile(formData: FormData) {
  const displayName = String(formData.get("display_name") ?? "").trim();
  const avatarFile = formData.get("avatar_file");
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const { data: existingProfile } = await supabase
    .from("user_profiles")
    .select("avatar_url")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  let avatarUrl: string | null = ((existingProfile?.avatar_url as string | null | undefined) ?? null);
  if (avatarFile instanceof File && avatarFile.size > 0) {
    const maxBytes = 256 * 1024;
    if (avatarFile.size > maxBytes) {
      redirect(`/app/settings?error=${encodeURIComponent("画像サイズは256KB以下にしてください。")}`);
    }
    if (!avatarFile.type.startsWith("image/")) {
      redirect(`/app/settings?error=${encodeURIComponent("画像ファイルを選択してください。")}`);
    }
    const bytes = Buffer.from(await avatarFile.arrayBuffer());
    const base64 = bytes.toString("base64");
    avatarUrl = `data:${avatarFile.type};base64,${base64}`;
  }
  const baseHandle = toHandle(displayName) || userId.slice(0, 8);
  let mentionHandle = baseHandle;
  const { data: conflict } = await supabase
    .from("user_profiles")
    .select("id")
    .eq("org_id", orgId)
    .eq("mention_handle", baseHandle)
    .neq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (conflict?.id) {
    mentionHandle = `${baseHandle}_${userId.slice(0, 4)}`;
  }
  const { error } = await supabase.from("user_profiles").upsert(
    {
      org_id: orgId,
      user_id: userId,
      display_name: displayName.length > 0 ? displayName : null,
      mention_handle: mentionHandle,
      avatar_url: avatarUrl,
      updated_at: new Date().toISOString()
    },
    { onConflict: "org_id,user_id", ignoreDuplicates: false }
  );

  if (error) {
    redirect(`/app/settings?error=${encodeURIComponent(`プロフィール更新に失敗しました: ${error.message}`)}`);
  }
  redirect("/app/settings?ok=profile_updated");
}
