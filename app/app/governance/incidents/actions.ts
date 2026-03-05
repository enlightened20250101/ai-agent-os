"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendTaskEvent, getOrCreateAgentOpsTaskId } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(kind: "ok" | "error", message: string) {
  return `/app/governance/incidents?${kind}=${encodeURIComponent(message)}`;
}

function isMissingIncidentTable(message: string) {
  return (
    message.includes('relation "org_incidents" does not exist') ||
    message.includes("Could not find the table 'public.org_incidents'")
  );
}

export async function declareIncident(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const reason = String(formData.get("reason") ?? "").trim();
  const severityRaw = String(formData.get("severity") ?? "critical").trim();
  const severity =
    severityRaw === "info" || severityRaw === "warning" || severityRaw === "critical"
      ? severityRaw
      : "critical";

  if (!reason) {
    redirect(withMessage("error", "理由を入力してください。"));
  }

  const { data: inserted, error } = await supabase
    .from("org_incidents")
    .insert({
      org_id: orgId,
      status: "open",
      severity,
      reason,
      opened_by: userId
    })
    .select("id, severity, reason, opened_at")
    .single();

  if (error) {
    if (isMissingIncidentTable(error.message)) {
      redirect(withMessage("error", "incident migration が未適用です。Supabase migration を実行してください。"));
    }
    redirect(withMessage("error", error.message));
  }

  const systemTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: systemTaskId,
    actorType: "user",
    actorId: userId,
    eventType: "INCIDENT_DECLARED",
    payload: {
      incident_id: inserted.id,
      severity: inserted.severity,
      reason: inserted.reason,
      opened_at: inserted.opened_at
    }
  });

  revalidatePath("/app/governance/incidents");
  redirect(withMessage("ok", "インシデントを宣言しました。自動実行は停止されます。"));
}

export async function resolveIncident(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const incidentId = String(formData.get("incident_id") ?? "").trim();
  if (!incidentId) {
    redirect(withMessage("error", "incident_id がありません。"));
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("org_incidents")
    .update({
      status: "resolved",
      resolved_by: userId,
      resolved_at: nowIso,
      updated_at: nowIso
    })
    .eq("id", incidentId)
    .eq("org_id", orgId)
    .eq("status", "open")
    .select("id, severity, reason, resolved_at")
    .maybeSingle();

  if (error) {
    if (isMissingIncidentTable(error.message)) {
      redirect(withMessage("error", "incident migration が未適用です。Supabase migration を実行してください。"));
    }
    redirect(withMessage("error", error.message));
  }
  if (!updated) {
    redirect(withMessage("error", "対象インシデントが見つからないか、すでに解決済みです。"));
  }

  const systemTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: systemTaskId,
    actorType: "user",
    actorId: userId,
    eventType: "INCIDENT_RESOLVED",
    payload: {
      incident_id: updated.id,
      severity: updated.severity,
      reason: updated.reason,
      resolved_at: updated.resolved_at
    }
  });

  revalidatePath("/app/governance/incidents");
  redirect(withMessage("ok", "インシデントを解決しました。"));
}

