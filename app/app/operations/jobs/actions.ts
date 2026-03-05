"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrCreateGovernanceOpsTaskId } from "@/lib/governance/review";
import { recordJobCircuitManualClear } from "@/lib/governance/jobCircuitBreaker";
import { maybeSendOpsFailureAlert } from "@/lib/governance/opsAlerts";
import { evaluateAndMaybeOpenIncident } from "@/lib/governance/incidentAuto";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { tickWorkflowRuns } from "@/lib/workflows/orchestrator";

function withMessage(kind: "ok" | "error", message: string) {
  return `/app/operations/jobs?${kind}=${encodeURIComponent(message)}`;
}

function isMissingTable(message: string, table: string) {
  return message.includes(`relation "${table}" does not exist`) || message.includes(`public.${table}`);
}

export async function resendOpsAlertNow() {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const result = await maybeSendOpsFailureAlert({
    supabase,
    orgId,
    force: true,
    source: "manual"
  });

  revalidatePath("/app/operations/jobs");

  if (result.sent) {
    redirect(withMessage("ok", `Opsアラートを再送しました。reason=${result.reason}`));
  }
  redirect(withMessage("error", `Opsアラート再送を実行できませんでした。reason=${result.reason}`));
}

export async function runWorkflowTickNow() {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const result = await tickWorkflowRuns({
    supabase,
    orgId,
    actorId: userId,
    limit: 20
  });

  revalidatePath("/app/operations/jobs");
  redirect(
    withMessage(
      "ok",
      `Workflow Tickを実行しました。scanned=${result.scanned}, completed=${result.completed}, running=${result.running}, failed=${result.failed}`
    )
  );
}

export async function runAutoIncidentCheckNow() {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const result = await evaluateAndMaybeOpenIncident({
    supabase,
    orgId,
    actorUserId: userId,
    source: "manual"
  });

  revalidatePath("/app/operations/jobs");
  revalidatePath("/app/governance/incidents");

  if (result.opened) {
    redirect(
      withMessage(
        "ok",
        `自動インシデントを宣言しました。incident_id=${result.incidentId ?? "-"} trigger=${result.trigger ?? "-"}`
      )
    );
  }
  redirect(withMessage("ok", `自動インシデント判定: ${result.reason}`));
}

export async function clearJobCircuitNow(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const jobName = String(formData.get("job_name") ?? "").trim();
  const reasonRaw = String(formData.get("reason") ?? "").trim();
  const reason = reasonRaw.slice(0, 500) || "manual_clear";

  const targetQuery = supabase
    .from("org_job_circuit_breakers")
    .select("job_name, paused_until, consecutive_failures")
    .eq("org_id", orgId);
  if (jobName) {
    targetQuery.eq("job_name", jobName);
  }

  const { data: targets, error: targetError } = await targetQuery;
  if (targetError) {
    if (isMissingTable(targetError.message, "org_job_circuit_breakers")) {
      redirect(withMessage("error", "サーキット管理テーブルが未作成です。migrationを適用してください。"));
    }
    redirect(withMessage("error", `サーキット状態の読み込みに失敗しました: ${targetError.message}`));
  }

  if (!targets || targets.length === 0) {
    revalidatePath("/app/operations/jobs");
    redirect(withMessage("ok", jobName ? `対象job(${jobName})は見つかりませんでした。` : "解除対象はありませんでした。"));
  }

  const nowIso = new Date().toISOString();
  if (jobName) {
    try {
      await recordJobCircuitManualClear({
        supabase,
        orgId,
        jobName
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "manual clear failed";
      redirect(withMessage("error", `サーキット解除に失敗しました: ${message}`));
    }
  } else {
    const updateQuery = supabase
      .from("org_job_circuit_breakers")
      .update({
        consecutive_failures: 0,
        paused_until: null,
        resume_stage: "active",
        dry_run_until: null,
        manual_cleared_at: nowIso,
        last_error: null,
        updated_at: nowIso
      })
      .eq("org_id", orgId);
    const { error: updateError } = await updateQuery;
    if (updateError) {
      const fallback = await supabase
        .from("org_job_circuit_breakers")
        .update({
          consecutive_failures: 0,
          paused_until: null,
          last_error: null,
          updated_at: nowIso
        })
        .eq("org_id", orgId);
      if (fallback.error) {
        redirect(withMessage("error", `サーキット解除に失敗しました: ${fallback.error.message}`));
      }
    }
  }

  try {
    const taskId = await getOrCreateGovernanceOpsTaskId({ supabase, orgId });
    await supabase.from("task_events").insert({
      org_id: orgId,
      task_id: taskId,
      actor_type: "user",
      actor_id: userId,
      event_type: "OPS_JOB_CIRCUIT_MANUALLY_CLEARED",
      payload_json: {
        job_name: jobName || "all",
        reason,
        cleared_count: targets.length,
        cleared_at: nowIso
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown log error";
    console.error(`[OPS_JOB_CIRCUIT_MANUAL_CLEAR_LOG_ERROR] org_id=${orgId} ${message}`);
  }

  revalidatePath("/app/operations/jobs");
  redirect(
    withMessage(
      "ok",
      jobName
        ? `job(${jobName})のサーキットを解除しました。reason=${reason}`
        : `全ジョブのサーキット状態を解除しました。count=${targets.length} reason=${reason}`
    )
  );
}
