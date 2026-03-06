"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function toPath(kind: "ok" | "error", message: string) {
  return `/app/partners?${kind}=${encodeURIComponent(message)}`;
}

export async function createVendor(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!name) redirect(toPath("error", "取引先名は必須です。"));

  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const { error } = await supabase.from("vendors").insert({
    org_id: orgId,
    name,
    email: email || null,
    notes: notes || null,
    status: "active"
  });
  if (error) redirect(toPath("error", `取引先作成に失敗しました: ${error.message}`));
  revalidatePath("/app/partners");
  redirect(toPath("ok", "取引先を作成しました。"));
}

export async function updateVendor(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!id || !["active", "inactive"].includes(status)) redirect(toPath("error", "不正な更新です。"));

  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const { error } = await supabase
    .from("vendors")
    .update({ status, notes: notes || null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) redirect(toPath("error", `取引先更新に失敗しました: ${error.message}`));
  revalidatePath("/app/partners");
  redirect(toPath("ok", "取引先を更新しました。"));
}

export async function createExternalContact(formData: FormData) {
  const displayName = String(formData.get("display_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!displayName) redirect(toPath("error", "社外連絡先名は必須です。"));

  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const { error } = await supabase.from("external_contacts").insert({
    org_id: orgId,
    display_name: displayName,
    email: email || null,
    company: company || null,
    notes: notes || null
  });
  if (error) redirect(toPath("error", `社外連絡先作成に失敗しました: ${error.message}`));
  revalidatePath("/app/partners");
  revalidatePath("/app/chat/channels");
  redirect(toPath("ok", "社外連絡先を作成しました。"));
}
