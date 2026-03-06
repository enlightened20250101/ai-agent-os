"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(kind: "ok" | "error", message: string) {
  return `/app/governance/autonomy?${kind}=${encodeURIComponent(message)}`;
}

function parseIntInRange(value: FormDataEntryValue | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function isMissingGovernanceTable(message: string) {
  return (
    message.includes('relation "org_autonomy_settings" does not exist') ||
    message.includes("Could not find the table 'public.org_autonomy_settings'")
  );
}

export async function saveAutonomySettings(formData: FormData) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const autonomyLevelRaw = String(formData.get("autonomy_level") ?? "L1").trim();
  const autonomyLevel =
    autonomyLevelRaw === "L0" ||
    autonomyLevelRaw === "L1" ||
    autonomyLevelRaw === "L2" ||
    autonomyLevelRaw === "L3" ||
    autonomyLevelRaw === "L4"
      ? autonomyLevelRaw
      : "L1";

  const payload = {
    org_id: orgId,
    autonomy_level: autonomyLevel,
    auto_execute_google_send_email: formData.get("auto_execute_google_send_email") === "on",
    enforce_initiator_approver_separation: formData.get("enforce_initiator_approver_separation") === "on",
    max_auto_execute_risk_score: parseIntInRange(formData.get("max_auto_execute_risk_score"), 25, 0, 100),
    min_trust_score: parseIntInRange(formData.get("min_trust_score"), 80, 0, 100),
    daily_send_email_limit: parseIntInRange(formData.get("daily_send_email_limit"), 20, 0, 100000),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase.from("org_autonomy_settings").upsert(payload, { onConflict: "org_id" });
  if (error) {
    if (isMissingGovernanceTable(error.message)) {
      redirect(withMessage("error", "governance migration が未適用です。先に Supabase migration を実行してください。"));
    }
    redirect(withMessage("error", error.message));
  }

  revalidatePath("/app/governance/autonomy");
  redirect(withMessage("ok", "自律設定を更新しました。"));
}
