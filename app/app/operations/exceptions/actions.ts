"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendExceptionCaseEvent } from "@/lib/governance/exceptionCaseEvents";
import { requireOrgContext } from "@/lib/org/context";
import { notifyExceptionCases } from "@/lib/governance/exceptionAlerts";
import { createClient } from "@/lib/supabase/server";
import { retryFailedWorkflowRun } from "@/lib/workflows/orchestrator";

function withMessage(kind: "ok" | "error", message: string) {
  return `/app/operations/exceptions?${kind}=${encodeURIComponent(message)}`;
}

function safeReturnTo(raw: string) {
  if (!raw.startsWith("/app")) return null;
  return raw;
}

function withReturnMessage(returnTo: string | null, kind: "ok" | "error", message: string) {
  if (!returnTo) return withMessage(kind, message);
  const separator = returnTo.includes("?") ? "&" : "?";
  return `${returnTo}${separator}${kind}=${encodeURIComponent(message)}`;
}

export async function retryWorkflowRunFromExceptions(formData: FormData) {
  const workflowRunId = String(formData.get("workflow_run_id") ?? "").trim();
  if (!workflowRunId) {
    redirect(withMessage("error", "workflow_run_id がありません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  try {
    await retryFailedWorkflowRun({
      supabase,
      orgId,
      workflowRunId,
      actorId: userId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "workflow run 再試行に失敗しました。";
    redirect(withMessage("error", message));
  }

  revalidatePath("/app/operations/exceptions");
  revalidatePath(`/app/workflows/runs/${workflowRunId}`);
  revalidatePath("/app/workflows/runs");
  redirect(withMessage("ok", "workflow run を再試行しました。"));
}

export async function retryTopFailedWorkflowRuns(formData: FormData) {
  const limitRaw = Number.parseInt(String(formData.get("limit") ?? "3"), 10);
  const limit = Number.isNaN(limitRaw) ? 3 : Math.max(1, Math.min(20, limitRaw));
  const returnTo = safeReturnTo(String(formData.get("return_to") ?? "").trim());

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: runs, error: runsError } = await supabase
    .from("workflow_runs")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "failed")
    .order("finished_at", { ascending: false })
    .limit(limit);

  if (runsError) {
    redirect(withReturnMessage(returnTo, "error", `失敗run取得に失敗しました: ${runsError.message}`));
  }

  const targets = (runs ?? []).map((row) => row.id as string).filter(Boolean);
  if (targets.length === 0) {
    redirect(withReturnMessage(returnTo, "ok", "再試行対象の失敗workflow runはありません。"));
  }

  let successCount = 0;
  let failCount = 0;
  for (const workflowRunId of targets) {
    try {
      await retryFailedWorkflowRun({
        supabase,
        orgId,
        workflowRunId,
        actorId: userId
      });
      successCount += 1;
    } catch {
      failCount += 1;
    }
  }

  revalidatePath("/app/operations/exceptions");
  revalidatePath("/app/workflows/runs");
  if (returnTo?.startsWith("/app/workflows")) {
    revalidatePath("/app/workflows");
  }
  if (returnTo === "/app" || returnTo?.startsWith("/app?")) {
    revalidatePath("/app");
  }
  redirect(withReturnMessage(returnTo, "ok", `一括再試行: success=${successCount}, failed=${failCount}`));
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

type ExceptionKind = "failed_action" | "failed_workflow" | "stale_approval" | "policy_block";

type ExceptionCaseRow = {
  id: string;
  kind: ExceptionKind;
  ref_id: string;
  status: "open" | "in_progress" | "resolved";
  owner_user_id: string | null;
  note: string;
  due_at: string | null;
};

function sameTimestamp(a: string | null, b: string | null) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return a === b;
  return ta === tb;
}

function buildChangedFields(prev: ExceptionCaseRow | null, next: ExceptionCaseRow) {
  if (!prev) {
    return {
      created: true,
      next
    };
  }
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  if (prev.status !== next.status) changed.status = { from: prev.status, to: next.status };
  if (prev.owner_user_id !== next.owner_user_id) {
    changed.owner_user_id = { from: prev.owner_user_id, to: next.owner_user_id };
  }
  if (prev.note !== next.note) changed.note = { from: prev.note, to: next.note };
  if (!sameTimestamp(prev.due_at, next.due_at)) changed.due_at = { from: prev.due_at, to: next.due_at };
  return changed;
}

export async function upsertExceptionCase(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const kind = String(formData.get("kind") ?? "").trim() as ExceptionKind;
  const refId = String(formData.get("ref_id") ?? "").trim();
  const taskIdRaw = String(formData.get("task_id") ?? "").trim();
  const taskId = taskIdRaw || null;
  const statusRaw = String(formData.get("status") ?? "open").trim();
  const status =
    statusRaw === "open" || statusRaw === "in_progress" || statusRaw === "resolved" ? statusRaw : "open";
  const ownerUserIdRaw = String(formData.get("owner_user_id") ?? "").trim();
  const ownerUserId = ownerUserIdRaw || null;
  const note = String(formData.get("note") ?? "").trim();
  const dueAtInput = String(formData.get("due_at") ?? "").trim();
  const dueAtIso =
    dueAtInput.length > 0
      ? (() => {
          const parsed = new Date(dueAtInput);
          return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
        })()
      : null;

  if (!refId || !kind) {
    redirect(withMessage("error", "kind/ref_id が不足しています。"));
  }

  const nowIso = new Date().toISOString();
  const { data: previous } = await supabase
    .from("exception_cases")
    .select("id, kind, ref_id, status, owner_user_id, note, due_at")
    .eq("org_id", orgId)
    .eq("kind", kind)
    .eq("ref_id", refId)
    .maybeSingle();
  const upsertPayload = {
    org_id: orgId,
    kind,
    ref_id: refId,
    task_id: taskId,
    status,
    owner_user_id: ownerUserId,
    note,
    due_at: dueAtIso,
    updated_at: nowIso,
    resolved_at: status === "resolved" ? nowIso : null
  };

  const { data: updated, error } = await supabase
    .from("exception_cases")
    .upsert(upsertPayload, {
      onConflict: "org_id,kind,ref_id"
    })
    .select("id, kind, ref_id, status, owner_user_id, note, due_at")
    .single();

  if (error) {
    if (isMissingTableError(error.message, "exception_cases")) {
      redirect(withMessage("error", "exception_cases migration が未適用です。Supabase migration を実行してください。"));
    }
    redirect(withMessage("error", `例外ケース更新に失敗しました: ${error.message}`));
  }

  if (updated?.id) {
    await appendExceptionCaseEvent({
      supabase,
      orgId,
      exceptionCaseId: updated.id as string,
      actorUserId: userId,
      eventType: previous?.id ? "CASE_UPDATED" : "CASE_CREATED",
      payload: {
        kind,
        ref_id: refId,
        mode: "single",
        changed_fields: buildChangedFields((previous as ExceptionCaseRow | null) ?? null, updated as ExceptionCaseRow)
      }
    });
  }

  revalidatePath("/app/operations/exceptions");
  redirect(withMessage("ok", "例外ケースを更新しました。"));
}

export async function notifyExceptionCasesNow() {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const result = await notifyExceptionCases({
    supabase,
    orgId,
    source: "manual"
  });

  revalidatePath("/app/operations/exceptions");
  if (result.sent) {
    redirect(
      withMessage(
        "ok",
        `例外通知を送信しました。target=${result.targetCount} auto_assigned=${result.autoAssignedCount ?? 0}`
      )
    );
  }
  redirect(withMessage("error", `例外通知を送信できませんでした。reason=${result.reason}`));
}

export async function bulkUpdateExceptionCases(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const caseIdsRaw = formData.getAll("case_ids");
  const caseIds = Array.from(
    new Set(
      caseIdsRaw
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
  if (caseIds.length === 0) {
    redirect(withMessage("error", "一括更新対象が選択されていません。"));
  }

  const statusRaw = String(formData.get("status") ?? "").trim();
  const ownerRaw = String(formData.get("owner_user_id") ?? "").trim();
  const dueAtInput = String(formData.get("due_at") ?? "").trim();
  const clearDue = String(formData.get("clear_due") ?? "") === "1";

  const patch: Record<string, string | null> = {
    updated_at: new Date().toISOString()
  };
  if (statusRaw === "open" || statusRaw === "in_progress" || statusRaw === "resolved") {
    patch.status = statusRaw;
    patch.resolved_at = statusRaw === "resolved" ? new Date().toISOString() : null;
  }
  if (ownerRaw.length > 0) {
    patch.owner_user_id = ownerRaw;
  } else if (String(formData.get("owner_user_id") ?? "") === "") {
    patch.owner_user_id = null;
  }

  if (clearDue) {
    patch.due_at = null;
  } else if (dueAtInput.length > 0) {
    const parsed = new Date(dueAtInput);
    if (Number.isFinite(parsed.getTime())) {
      patch.due_at = parsed.toISOString();
    }
  }

  const { data: beforeRows } = await supabase
    .from("exception_cases")
    .select("id, kind, ref_id, status, owner_user_id, note, due_at")
    .eq("org_id", orgId)
    .in("id", caseIds);

  const { data: updatedRows, error } = await supabase
    .from("exception_cases")
    .update(patch)
    .eq("org_id", orgId)
    .in("id", caseIds)
    .select("id, kind, ref_id, status, owner_user_id, note, due_at");
  if (error) {
    if (isMissingTableError(error.message, "exception_cases")) {
      redirect(withMessage("error", "exception_cases migration が未適用です。Supabase migration を実行してください。"));
    }
    redirect(withMessage("error", `一括更新に失敗しました: ${error.message}`));
  }

  const beforeMap = new Map(((beforeRows ?? []) as ExceptionCaseRow[]).map((row) => [row.id, row]));
  for (const row of (updatedRows ?? []) as ExceptionCaseRow[]) {
    const prev = beforeMap.get(row.id) ?? null;
    await appendExceptionCaseEvent({
      supabase,
      orgId,
      exceptionCaseId: row.id,
      actorUserId: userId,
      eventType: "CASE_BULK_UPDATED",
      payload: {
        kind: row.kind,
        ref_id: row.ref_id,
        mode: "bulk",
        changed_fields: buildChangedFields(prev, row)
      }
    });
  }

  revalidatePath("/app/operations/exceptions");
  redirect(withMessage("ok", `一括更新しました。count=${caseIds.length}`));
}
