"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendCaseEventSafe } from "@/lib/cases/events";
import { deriveCaseStage, summarizeTaskStatuses } from "@/lib/cases/stage";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(kind: "ok" | "error", message: string, returnTo = "/app/cases") {
  return `${returnTo}?${kind}=${encodeURIComponent(message)}`;
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function isMissingColumnError(message: string, columnName: string) {
  return message.includes(`column ${columnName} does not exist`) || message.includes(`Could not find the '${columnName}' column`);
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
    stage: "intake",
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
      stage: "intake",
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

export async function syncCaseStagesNow() {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: cases, error: casesError } = await supabase
    .from("business_cases")
    .select("id, status, stage")
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(1000);

  if (casesError) {
    if (isMissingTableError(casesError.message, "business_cases")) {
      redirect(withMessage("error", "business_cases migration 未適用です。`supabase db push` を実行してください。"));
    }
    if (isMissingColumnError(casesError.message, "business_cases.stage")) {
      redirect(withMessage("error", "case stage migration 未適用です。`supabase db push` を実行してください。"));
    }
    redirect(withMessage("error", `案件読み込みに失敗しました: ${casesError.message}`));
  }

  const caseRows = (cases ?? []) as Array<{ id: string; status: "open" | "blocked" | "closed"; stage: string | null }>;
  if (caseRows.length === 0) {
    redirect(withMessage("ok", "同期対象の案件はありません。"));
  }

  const caseIds = caseRows.map((row) => row.id);
  const { data: tasks, error: tasksError } = await supabase
    .from("tasks")
    .select("case_id, status")
    .eq("org_id", orgId)
    .in("case_id", caseIds);

  if (tasksError) {
    redirect(withMessage("error", `タスク集計に失敗しました: ${tasksError.message}`));
  }

  const taskStatusesByCaseId = new Map<string, string[]>();
  for (const row of tasks ?? []) {
    const caseId = (row.case_id as string | null) ?? null;
    if (!caseId) continue;
    const list = taskStatusesByCaseId.get(caseId) ?? [];
    list.push(String(row.status ?? ""));
    taskStatusesByCaseId.set(caseId, list);
  }

  let changedCount = 0;
  for (const row of caseRows) {
    const statuses = taskStatusesByCaseId.get(row.id) ?? [];
    const nextStage = deriveCaseStage({ caseStatus: row.status, taskStatuses: statuses });
    if ((row.stage ?? "intake") === nextStage) continue;

    const { error: updateError } = await supabase
      .from("business_cases")
      .update({ stage: nextStage, updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("id", row.id);
    if (updateError) {
      redirect(withMessage("error", `案件ステージ更新に失敗しました: ${updateError.message}`));
    }
    changedCount += 1;

    await appendCaseEventSafe({
      supabase,
      orgId,
      caseId: row.id,
      actorUserId: userId,
      eventType: "CASE_STAGE_SYNCED",
      payload: {
        changed_fields: {
          stage: {
            from: row.stage ?? null,
            to: nextStage
          }
        },
        task_status_summary: summarizeTaskStatuses(statuses),
        source: "case_stage_sync"
      }
    });
  }

  revalidatePath("/app/cases");
  redirect(withMessage("ok", `ケースステージを同期しました。updated=${changedCount}`));
}

export async function autoAssignStaleCasesToMe(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnToRaw = String(formData.get("return_to") ?? "/app/monitor").trim();
  const returnTo = returnToRaw.startsWith("/app") ? returnToRaw : "/app/monitor";
  const limitRaw = Number.parseInt(String(formData.get("limit") ?? "5"), 10);
  const limit = Number.isNaN(limitRaw) ? 5 : Math.max(1, Math.min(50, limitRaw));
  const staleHoursRaw = Number.parseInt(process.env.CASE_STALE_HOURS ?? "48", 10);
  const staleHours = Number.isNaN(staleHoursRaw) ? 48 : Math.max(1, Math.min(720, staleHoursRaw));
  const staleCutoffIso = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();

  const { data: targets, error: targetsError } = await supabase
    .from("business_cases")
    .select("id, owner_user_id")
    .eq("org_id", orgId)
    .eq("status", "open")
    .is("owner_user_id", null)
    .lt("updated_at", staleCutoffIso)
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (targetsError) {
    if (isMissingTableError(targetsError.message, "business_cases")) {
      redirect(withMessage("error", "business_cases migration 未適用です。`supabase db push` を実行してください。", returnTo));
    }
    redirect(withMessage("error", `滞留案件取得に失敗しました: ${targetsError.message}`, returnTo));
  }

  const rows = (targets ?? []) as Array<{ id: string; owner_user_id: string | null }>;
  if (rows.length === 0) {
    redirect(withMessage("ok", "自動割当対象の滞留案件はありません。", returnTo));
  }

  let updated = 0;
  for (const row of rows) {
    const { error: updateError } = await supabase
      .from("business_cases")
      .update({ owner_user_id: userId, updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("id", row.id)
      .is("owner_user_id", null);
    if (updateError) {
      continue;
    }
    updated += 1;
    await appendCaseEventSafe({
      supabase,
      orgId,
      caseId: row.id,
      actorUserId: userId,
      eventType: "CASE_OWNER_UPDATED",
      payload: {
        changed_fields: {
          owner_user_id: {
            from: null,
            to: userId
          }
        },
        source: "auto_assign_stale_cases"
      }
    });
  }

  revalidatePath("/app/cases");
  revalidatePath("/app/monitor");
  redirect(withMessage("ok", `滞留案件を自動割当しました。updated=${updated} target=${rows.length}`, returnTo));
}
