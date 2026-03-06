"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(kind: "ok" | "error", message: string) {
  return `/app/cases?${kind}=${encodeURIComponent(message)}`;
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export async function createCase(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim();
  const caseType = String(formData.get("case_type") ?? "general").trim() || "general";

  if (!title) {
    redirect(withMessage("error", "案件タイトルは必須です。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { error } = await supabase.from("business_cases").insert({
    org_id: orgId,
    created_by_user_id: userId,
    case_type: caseType,
    title,
    status: "open",
    source: "manual"
  });

  if (error) {
    if (isMissingTableError(error.message, "business_cases")) {
      redirect(withMessage("error", "business_cases migration 未適用です。`supabase db push` を実行してください。"));
    }
    redirect(withMessage("error", `案件の作成に失敗しました: ${error.message}`));
  }

  revalidatePath("/app/cases");
  revalidatePath("/app/tasks");
  redirect(withMessage("ok", "案件を作成しました。"));
}

export async function updateCaseStatus(formData: FormData) {
  const caseId = String(formData.get("case_id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  if (!caseId || !["open", "blocked", "closed"].includes(status)) {
    redirect(withMessage("error", "不正なパラメータです。"));
  }

  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const { error } = await supabase
    .from("business_cases")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", caseId)
    .eq("org_id", orgId);

  if (error) {
    if (isMissingTableError(error.message, "business_cases")) {
      redirect(withMessage("error", "business_cases migration 未適用です。`supabase db push` を実行してください。"));
    }
    redirect(withMessage("error", `案件の更新に失敗しました: ${error.message}`));
  }

  revalidatePath("/app/cases");
  redirect(withMessage("ok", "案件ステータスを更新しました。"));
}
