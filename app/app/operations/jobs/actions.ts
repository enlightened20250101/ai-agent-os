"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sendApprovalReminders } from "@/lib/approvals/reminders";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { getOrCreateGovernanceOpsTaskId } from "@/lib/governance/review";
import { runGovernanceRecommendationReview } from "@/lib/governance/review";
import { recordJobCircuitManualClear } from "@/lib/governance/jobCircuitBreaker";
import { maybeSendOpsFailureAlert } from "@/lib/governance/opsAlerts";
import { evaluateAndMaybeOpenIncident } from "@/lib/governance/incidentAuto";
import { assertNoOpenIncidentForMutation } from "@/lib/governance/incidents";
import { runAutoCaseifyForOrg } from "@/lib/events/autoCaseify";
import { requireOrgContext } from "@/lib/org/context";
import { runPlanner } from "@/lib/planner/runPlanner";
import { createClient } from "@/lib/supabase/server";
import { tickWorkflowRuns } from "@/lib/workflows/orchestrator";

function resolveReturnTo(formData?: FormData) {
  const raw = String(formData?.get("return_to") ?? "").trim();
  if (raw.startsWith("/app/")) return raw;
  return "/app/operations/jobs";
}

function withMessage(kind: "ok" | "error", message: string, returnTo?: string) {
  const target = returnTo && returnTo.startsWith("/app/") ? returnTo : "/app/operations/jobs";
  const [base, query = ""] = target.split("?");
  const sp = new URLSearchParams(query);
  sp.set(kind, message);
  return `${base}?${sp.toString()}`;
}

function isMissingTable(message: string, table: string) {
  return message.includes(`relation "${table}" does not exist`) || message.includes(`public.${table}`);
}

async function logManualJobRun(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string | null;
  jobName: string;
  status: "ok" | "error";
  message: string;
  details?: Record<string, unknown>;
}) {
  try {
    const taskId = await getOrCreateGovernanceOpsTaskId({ supabase: args.supabase, orgId: args.orgId });
    await args.supabase.from("task_events").insert({
      org_id: args.orgId,
      task_id: taskId,
      actor_type: "user",
      actor_id: args.userId,
      event_type: "OPS_JOB_MANUAL_RUN",
      payload_json: {
        job_name: args.jobName,
        status: args.status,
        message: args.message,
        details: args.details ?? {}
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown manual run log error";
    console.error(`[OPS_JOB_MANUAL_RUN_LOG_ERROR] org_id=${args.orgId} job=${args.jobName} ${message}`);
  }
}

export async function resendOpsAlertNow(formData?: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnTo = resolveReturnTo(formData);

  const result = await maybeSendOpsFailureAlert({
    supabase,
    orgId,
    force: true,
    source: "manual"
  });

  revalidatePath("/app/operations/jobs");

  if (result.sent) {
    await logManualJobRun({
      supabase,
      orgId,
      userId,
      jobName: "ops_alert_resend",
      status: "ok",
      message: `Opsアラート再送成功: reason=${result.reason}`,
      details: { alert_reason: result.reason }
    });
    redirect(withMessage("ok", `Opsアラートを再送しました。reason=${result.reason}`, returnTo));
  }
  await logManualJobRun({
    supabase,
    orgId,
    userId,
    jobName: "ops_alert_resend",
    status: "error",
    message: `Opsアラート再送失敗: reason=${result.reason}`,
    details: { alert_reason: result.reason, error: result.error ?? null }
  });
  redirect(withMessage("error", `Opsアラート再送を実行できませんでした。reason=${result.reason}`, returnTo));
}

export async function runWorkflowTickNow(formData?: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnTo = resolveReturnTo(formData);

  const result = await tickWorkflowRuns({
    supabase,
    orgId,
    actorId: userId,
    limit: 20
  });

  revalidatePath("/app/operations/jobs");
  await logManualJobRun({
    supabase,
    orgId,
    userId,
    jobName: "workflow_tick",
    status: "ok",
    message: `Workflow Tick実行: scanned=${result.scanned}, completed=${result.completed}, running=${result.running}, failed=${result.failed}`,
    details: {
      scanned: result.scanned,
      completed: result.completed,
      running: result.running,
      failed: result.failed
    }
  });
  redirect(
    withMessage(
      "ok",
      `Workflow Tickを実行しました。scanned=${result.scanned}, completed=${result.completed}, running=${result.running}, failed=${result.failed}`,
      returnTo
    )
  );
}

export async function runAutoIncidentCheckNow(formData?: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnTo = resolveReturnTo(formData);

  const result = await evaluateAndMaybeOpenIncident({
    supabase,
    orgId,
    actorUserId: userId,
    source: "manual"
  });

  revalidatePath("/app/operations/jobs");
  revalidatePath("/app/governance/incidents");

  if (result.opened) {
    await logManualJobRun({
      supabase,
      orgId,
      userId,
      jobName: "auto_incident_check",
      status: "ok",
      message: `自動インシデント宣言: incident_id=${result.incidentId ?? "-"} trigger=${result.trigger ?? "-"}`,
      details: { opened: true, incident_id: result.incidentId ?? null, trigger: result.trigger ?? null }
    });
    redirect(
      withMessage(
        "ok",
        `自動インシデントを宣言しました。incident_id=${result.incidentId ?? "-"} trigger=${result.trigger ?? "-"}`,
        returnTo
      )
    );
  }
  await logManualJobRun({
    supabase,
    orgId,
    userId,
    jobName: "auto_incident_check",
    status: "ok",
    message: `自動インシデント判定: ${result.reason}`,
    details: { opened: false, reason: result.reason }
  });
  redirect(withMessage("ok", `自動インシデント判定: ${result.reason}`, returnTo));
}

export async function runAutoCaseifyNow(formData?: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnTo = resolveReturnTo(formData);

  const result = await runAutoCaseifyForOrg({
    supabase,
    orgId,
    actorUserId: userId,
    limit: 50
  });

  revalidatePath("/app/operations/jobs");
  revalidatePath("/app/events");
  revalidatePath("/app/cases");
  await logManualJobRun({
    supabase,
    orgId,
    userId,
    jobName: "events_auto_caseify",
    status: "ok",
    message: `外部イベント自動Case化: scanned=${result.scanned}, created=${result.created}, skipped=${result.skipped}, failed=${result.failed}`,
    details: {
      scanned: result.scanned,
      created: result.created,
      skipped: result.skipped,
      failed: result.failed
    }
  });
  redirect(
    withMessage(
      "ok",
      `外部イベント自動Case化を実行しました。scanned=${result.scanned}, created=${result.created}, skipped=${result.skipped}, failed=${result.failed}`,
      returnTo
    )
  );
}

export async function runPlannerNow(formData?: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnTo = resolveReturnTo(formData);
  await assertNoOpenIncidentForMutation({
    supabase,
    orgId,
    operation: "planner manual run"
  });

  const result = await runPlanner({
    supabase,
    orgId,
    actorUserId: userId,
    maxProposals: 3
  });

  revalidatePath("/app/operations/jobs");
  revalidatePath("/app/planner");
  revalidatePath("/app/proposals");
  await logManualJobRun({
    supabase,
    orgId,
    userId,
    jobName: "planner_run",
    status: result.status === "completed" ? "ok" : "error",
    message: `Planner実行: status=${result.status}, created_proposals=${result.createdProposals}, considered_signals=${result.consideredSignals}`,
    details: {
      status: result.status,
      created_proposals: result.createdProposals,
      considered_signals: result.consideredSignals
    }
  });
  redirect(
    withMessage(
      "ok",
      `Plannerを実行しました。status=${result.status}, created_proposals=${result.createdProposals}, considered_signals=${result.consideredSignals}`,
      returnTo
    )
  );
}

export async function runGovernanceReviewNow(formData?: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnTo = resolveReturnTo(formData);
  await assertNoOpenIncidentForMutation({
    supabase,
    orgId,
    operation: "governance review manual run"
  });

  const result = await runGovernanceRecommendationReview({ supabase, orgId });
  const alert = await maybeSendOpsFailureAlert({ supabase, orgId, source: "manual" });

  revalidatePath("/app/operations/jobs");
  revalidatePath("/app/governance/recommendations");
  if (!result.ok) {
    await logManualJobRun({
      supabase,
      orgId,
      userId,
      jobName: "governance_review",
      status: "error",
      message: `レビュー実行失敗: ${result.error ?? "unknown error"}`,
      details: { error: result.error ?? null, alert_reason: alert.reason }
    });
    redirect(withMessage("error", `レビュー実行に失敗しました: ${result.error ?? "unknown error"} / alert=${alert.reason}`, returnTo));
  }
  await logManualJobRun({
    supabase,
    orgId,
    userId,
    jobName: "governance_review",
    status: "ok",
    message: `レビュー実行成功: recommendations=${result.recommendationCount ?? 0}, critical=${result.criticalCount ?? 0}, high=${result.highCount ?? 0}`,
    details: {
      recommendation_count: result.recommendationCount ?? 0,
      critical_count: result.criticalCount ?? 0,
      high_count: result.highCount ?? 0
    }
  });
  redirect(
    withMessage(
      "ok",
      `レビューを実行しました。recommendations=${result.recommendationCount ?? 0}, critical=${result.criticalCount ?? 0}, high=${result.highCount ?? 0}`,
      returnTo
    )
  );
}

export async function clearJobCircuitNow(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnTo = resolveReturnTo(formData);
  const jobName = String(formData.get("job_name") ?? "").trim();
  const reasonRaw = String(formData.get("reason") ?? "").trim();
  const reason = reasonRaw.slice(0, 500);
  if (!reason) {
    redirect(withMessage("error", "サーキット解除理由を入力してください。", returnTo));
  }

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
      redirect(withMessage("error", "サーキット管理テーブルが未作成です。migrationを適用してください。", returnTo));
    }
    redirect(withMessage("error", `サーキット状態の読み込みに失敗しました: ${targetError.message}`, returnTo));
  }

  if (!targets || targets.length === 0) {
    revalidatePath("/app/operations/jobs");
    redirect(withMessage("ok", jobName ? `対象job(${jobName})は見つかりませんでした。` : "解除対象はありませんでした。", returnTo));
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
      redirect(withMessage("error", `サーキット解除に失敗しました: ${message}`, returnTo));
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
        redirect(withMessage("error", `サーキット解除に失敗しました: ${fallback.error.message}`, returnTo));
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
        : `全ジョブのサーキット状態を解除しました。count=${targets.length} reason=${reason}`,
      returnTo
    )
  );
}

function parseOneOffMinStale(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return Math.max(1, Math.min(1000, parsed));
}

export async function runGuardedApprovalReminderJobNow(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const returnTo = resolveReturnTo(formData);
  const minStaleRaw = String(formData.get("min_stale") ?? "").trim();
  const oneOffThreshold = parseOneOffMinStale(minStaleRaw);
  if (!oneOffThreshold) {
    redirect(withMessage("error", "min_stale が不正です。", returnTo));
  }

  const staleHours = Number(process.env.APPROVAL_REMINDER_STALE_HOURS ?? process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6");
  const staleCutoffIso = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
  const countRes = await supabase
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "pending")
    .lt("created_at", staleCutoffIso);
  if (countRes.error) {
    redirect(withMessage("error", `stale件数の取得に失敗しました: ${countRes.error.message}`, returnTo));
  }

  const stalePendingCount = countRes.count ?? 0;
  const governanceTaskId = await getOrCreateGovernanceOpsTaskId({ supabase, orgId });
  if (stalePendingCount < oneOffThreshold) {
    await appendTaskEvent({
      supabase,
      orgId,
      taskId: governanceTaskId,
      actorType: "user",
      actorId: userId,
      eventType: "APPROVAL_REMINDER_AUTO_SKIPPED",
      payload: {
        reason: "below_threshold",
        stale_pending_count: stalePendingCount,
        threshold: oneOffThreshold,
        stale_hours: staleHours,
        source: "jobs_manual"
      }
    });
    revalidatePath("/app/operations/jobs");
    revalidatePath("/app/approvals");
    redirect(withMessage("ok", `guardによりスキップ: stale=${stalePendingCount} threshold=${oneOffThreshold}`, returnTo));
  }

  const result = await sendApprovalReminders({
    supabase,
    orgId,
    actorUserId: userId,
    source: "manual"
  });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: governanceTaskId,
    actorType: "user",
    actorId: userId,
    eventType: "APPROVAL_REMINDER_AUTO_RUN",
    payload: {
      stale_pending_count: stalePendingCount,
      threshold: oneOffThreshold,
      stale_hours: staleHours,
      sent: result.sent,
      reason: result.reason,
      target_count: result.targetCount,
      sent_count: result.sentCount,
      skipped_cooldown_count: result.skippedCooldownCount,
      source: "jobs_manual"
    }
  });

  revalidatePath("/app/operations/jobs");
  revalidatePath("/app/approvals");
  redirect(
    withMessage(
      "ok",
      `guard実行: stale=${stalePendingCount} threshold=${oneOffThreshold} sent=${result.sentCount} reason=${result.reason}`,
      returnTo
    )
  );
}
