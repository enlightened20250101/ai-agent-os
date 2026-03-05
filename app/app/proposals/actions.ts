"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { acceptProposalShared } from "@/lib/proposals/decide";
import { createClient } from "@/lib/supabase/server";

function toError(message: string) {
  return `/app/proposals?error=${encodeURIComponent(message)}`;
}

function toOk(message: string) {
  return `/app/proposals?ok=${encodeURIComponent(message)}`;
}

function normalizeReasonCode(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  return value.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 64);
}

function composeDecisionReason(codeRaw: string, noteRaw: string) {
  const code = normalizeReasonCode(codeRaw) || "unspecified";
  const note = noteRaw.trim().replace(/\s+/g, " ").slice(0, 180);
  return note ? `${code}:${note}` : code;
}

function isMissingColumnError(message: string, columnName: string) {
  return (
    message.includes(`Could not find the '${columnName}' column`) ||
    message.includes(`column task_proposals.${columnName} does not exist`)
  );
}

export async function acceptProposal(formData: FormData) {
  const proposalId = String(formData.get("proposal_id") ?? "").trim();
  const decisionReasonCode = String(formData.get("decision_reason_code") ?? "").trim();
  const decisionReason = composeDecisionReason(decisionReasonCode || "accepted_manual", "");
  const autoRequestApproval = String(formData.get("auto_request_approval") ?? "") === "1";
  if (!proposalId) {
    redirect(toError("proposal_id がありません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  let accepted: Awaited<ReturnType<typeof acceptProposalShared>>;
  try {
    accepted = await acceptProposalShared({
      supabase,
      orgId,
      userId,
      proposalId,
      decisionReason,
      autoRequestApproval,
      source: "ui"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "提案受け入れに失敗しました。";
    redirect(toError(message));
  }

  revalidatePath("/app/proposals");
  revalidatePath("/app/tasks");
  revalidatePath("/app/approvals");
  revalidatePath(`/app/tasks/${accepted.taskId}`);
  redirect(
    `/app/tasks/${accepted.taskId}?ok=${encodeURIComponent(
      autoRequestApproval
        ? "提案を受け入れて承認依頼まで作成しました。"
        : "提案を受け入れてタスクを作成しました。"
    )}`
  );
}

export async function rejectProposal(formData: FormData) {
  const proposalId = String(formData.get("proposal_id") ?? "").trim();
  const reasonCodeRaw = String(formData.get("decision_reason_code") ?? "").trim();
  const reasonNote = String(formData.get("reason_note") ?? "").trim();
  const reason = composeDecisionReason(reasonCodeRaw || "rejected_other", reasonNote);
  if (!proposalId) {
    redirect(toError("proposal_id がありません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  let { error: updateError } = await supabase
    .from("task_proposals")
    .update({
      status: "rejected",
      decided_at: nowIso,
      decided_by: userId,
      decision_reason: reason || "rejected_via_ui"
    })
    .eq("id", proposalId)
    .eq("org_id", orgId)
    .eq("status", "proposed");
  if (updateError && isMissingColumnError(updateError.message, "decision_reason")) {
    const retry = await supabase
      .from("task_proposals")
      .update({
        status: "rejected",
        decided_at: nowIso,
        decided_by: userId
      })
      .eq("id", proposalId)
      .eq("org_id", orgId)
      .eq("status", "proposed");
    updateError = retry.error;
  }
  if (updateError) {
    redirect(toError(`提案の却下に失敗しました: ${updateError.message}`));
  }

  const { error: eventError } = await supabase.from("proposal_events").insert({
    org_id: orgId,
    proposal_id: proposalId,
    event_type: "PROPOSAL_REJECTED",
    payload_json: {
      reason: reason || null,
      decided_by: userId,
      decision_reason: reason || "rejected_via_ui",
      decision_reason_code: reason.split(":")[0],
      decision_reason_note: reason.includes(":") ? reason.slice(reason.indexOf(":") + 1) : null
    }
  });
  if (eventError) {
    redirect(toError(`却下イベント記録に失敗しました: ${eventError.message}`));
  }

  revalidatePath("/app/proposals");
  redirect(toOk("提案を却下しました。"));
}

export async function bulkRejectProposals(formData: FormData) {
  const proposalIds = formData
    .getAll("proposal_ids")
    .map((item) => String(item).trim())
    .filter(Boolean);
  const reasonCodeRaw = String(formData.get("decision_reason_code") ?? "").trim();
  const reasonNote = String(formData.get("reason_note") ?? "").trim();
  const reason = composeDecisionReason(reasonCodeRaw || "rejected_other", reasonNote);

  if (proposalIds.length === 0) {
    redirect(toError("却下対象の提案が選択されていません。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  let { data: rows, error: loadError } = await supabase
    .from("task_proposals")
    .select("id")
    .eq("org_id", orgId)
    .in("id", proposalIds)
    .eq("status", "proposed");
  if (loadError) {
    redirect(toError(`提案取得に失敗しました: ${loadError.message}`));
  }
  const targetIds = (rows ?? []).map((row) => row.id as string);
  if (targetIds.length === 0) {
    redirect(toError("却下可能な提案がありません。"));
  }

  let { error: updateError } = await supabase
    .from("task_proposals")
    .update({
      status: "rejected",
      decided_at: nowIso,
      decided_by: userId,
      decision_reason: reason
    })
    .eq("org_id", orgId)
    .in("id", targetIds)
    .eq("status", "proposed");
  if (updateError && isMissingColumnError(updateError.message, "decision_reason")) {
    const retry = await supabase
      .from("task_proposals")
      .update({
        status: "rejected",
        decided_at: nowIso,
        decided_by: userId
      })
      .eq("org_id", orgId)
      .in("id", targetIds)
      .eq("status", "proposed");
    updateError = retry.error;
  }
  if (updateError) {
    redirect(toError(`一括却下に失敗しました: ${updateError.message}`));
  }

  const eventRows = targetIds.map((proposalId) => ({
    org_id: orgId,
    proposal_id: proposalId,
    event_type: "PROPOSAL_REJECTED",
    payload_json: {
      reason,
      decided_by: userId,
      decision_reason: reason,
      decision_reason_code: reason.split(":")[0],
      decision_reason_note: reason.includes(":") ? reason.slice(reason.indexOf(":") + 1) : null,
      bulk: true
    }
  }));
  const { error: eventsError } = await supabase.from("proposal_events").insert(eventRows);
  if (eventsError) {
    redirect(toError(`一括却下イベント記録に失敗しました: ${eventsError.message}`));
  }

  revalidatePath("/app/proposals");
  redirect(toOk(`${targetIds.length}件の提案を却下しました。`));
}
