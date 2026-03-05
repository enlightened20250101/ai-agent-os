"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(kind: "ok" | "error", message: string) {
  return `/app/governance/budgets?${kind}=${encodeURIComponent(message)}`;
}

function parseLimit(value: FormDataEntryValue | null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(1_000_000, parsed));
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export async function saveDailySendEmailLimit(formData: FormData) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const limitCount = parseLimit(formData.get("limit_count"));
  if (limitCount === null) {
    redirect(withMessage("error", "limit_count が不正です。"));
  }

  const { error } = await supabase.from("budget_limits").upsert(
    {
      org_id: orgId,
      provider: "google",
      action_type: "send_email",
      period: "daily",
      limit_count: limitCount,
      updated_at: new Date().toISOString()
    },
    { onConflict: "org_id,provider,action_type,period" }
  );

  if (error) {
    if (isMissingTableError(error.message, "budget_limits")) {
      redirect(withMessage("error", "governance migration が未適用です。"));
    }
    redirect(withMessage("error", error.message));
  }

  revalidatePath("/app/governance/budgets");
  redirect(withMessage("ok", "日次送信上限を更新しました。"));
}
