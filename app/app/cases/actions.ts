"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendCaseEventSafe } from "@/lib/cases/events";
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

  const { data: createdCase, error } = await supabase
    .from("business_cases")
    .insert({
    org_id: orgId,
    created_by_user_id: userId,
    case_type: caseType,
    title,
    status: "open",
    source: "manual"
    })
    .select("id")
    .single();

  if (error) {
    if (isMissingTableError(error.message, "business_cases")) {
      redirect(withMessage("error", "business_cases migration 未適用です。`supabase db push` を実行してください。"));
    }
    redirect(withMessage("error", `案件の作成に失敗しました: ${error.message}`));
  }

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId: (createdCase?.id as string | undefined) ?? null,
    actorUserId: userId,
    eventType: "CASE_CREATED",
    payload: {
      title,
      case_type: caseType,
      status: "open",
      source: "manual"
    }
  });

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

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: beforeCase } = await supabase
    .from("business_cases")
    .select("id, status")
    .eq("id", caseId)
    .eq("org_id", orgId)
    .maybeSingle();

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

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId,
    actorUserId: userId,
    eventType: "CASE_STATUS_UPDATED",
    payload: {
      changed_fields: {
        status: {
          from: (beforeCase?.status as string | null) ?? null,
          to: status
        }
      },
      source: "case_status_update"
    }
  });

  revalidatePath("/app/cases");
  redirect(withMessage("ok", "案件ステータスを更新しました。"));
}

export async function updateCaseOwner(formData: FormData) {
  const caseId = String(formData.get("case_id") ?? "").trim();
  const ownerUserIdRaw = String(formData.get("owner_user_id") ?? "").trim();
  const ownerUserId = ownerUserIdRaw.length > 0 ? ownerUserIdRaw : null;
  if (!caseId) {
    redirect(withMessage("error", "不正なパラメータです。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: beforeCase } = await supabase
    .from("business_cases")
    .select("id, owner_user_id")
    .eq("id", caseId)
    .eq("org_id", orgId)
    .maybeSingle();

  const { error } = await supabase
    .from("business_cases")
    .update({ owner_user_id: ownerUserId, updated_at: new Date().toISOString() })
    .eq("id", caseId)
    .eq("org_id", orgId);

  if (error) {
    if (isMissingTableError(error.message, "business_cases")) {
      redirect(withMessage("error", "business_cases migration 未適用です。`supabase db push` を実行してください。"));
    }
    redirect(withMessage("error", `案件担当者の更新に失敗しました: ${error.message}`));
  }

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId,
    actorUserId: userId,
    eventType: "CASE_OWNER_UPDATED",
    payload: {
      changed_fields: {
        owner_user_id: {
          from: (beforeCase?.owner_user_id as string | null) ?? null,
          to: ownerUserId
        }
      },
      source: "case_owner_update"
    }
  });

  revalidatePath("/app/cases");
  revalidatePath(`/app/cases/${caseId}`);
  redirect(withMessage("ok", "案件担当者を更新しました。"));
}

export async function updateCaseDue(formData: FormData) {
  const caseId = String(formData.get("case_id") ?? "").trim();
  const dueAtRaw = String(formData.get("due_at") ?? "").trim();
  const dueAt = dueAtRaw.length > 0 ? new Date(dueAtRaw).toISOString() : null;
  if (!caseId || (dueAtRaw && !Number.isFinite(Date.parse(dueAtRaw)))) {
    redirect(withMessage("error", "不正な期限指定です。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: beforeCase } = await supabase
    .from("business_cases")
    .select("id, due_at")
    .eq("id", caseId)
    .eq("org_id", orgId)
    .maybeSingle();

  const { error } = await supabase
    .from("business_cases")
    .update({ due_at: dueAt, updated_at: new Date().toISOString() })
    .eq("id", caseId)
    .eq("org_id", orgId);

  if (error) {
    if (isMissingTableError(error.message, "business_cases")) {
      redirect(withMessage("error", "business_cases migration 未適用です。`supabase db push` を実行してください。"));
    }
    redirect(withMessage("error", `案件期限の更新に失敗しました: ${error.message}`));
  }

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId,
    actorUserId: userId,
    eventType: "CASE_DUE_UPDATED",
    payload: {
      changed_fields: {
        due_at: {
          from: (beforeCase?.due_at as string | null) ?? null,
          to: dueAt
        }
      },
      source: "case_due_update"
    }
  });

  revalidatePath("/app/cases");
  revalidatePath(`/app/cases/${caseId}`);
  redirect(withMessage("ok", "案件期限を更新しました。"));
}
