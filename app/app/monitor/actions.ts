"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendAiExecutionLog } from "@/lib/executions/logs";
import { getOpsRuntimeSettings } from "@/lib/governance/opsRuntimeSettings";
import { runMonitorTick } from "@/lib/monitor/runMonitor";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(kind: "ok" | "error", message: string, window: string) {
  const search = new URLSearchParams();
  search.set(kind, message);
  if (window === "24h" || window === "30d") {
    search.set("window", window);
  }
  return `/app/monitor?${search.toString()}`;
}

function parseIntInRange(value: FormDataEntryValue | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export async function runMonitorNow(formData: FormData) {
  const forcePlanner = String(formData.get("force_planner") ?? "") === "1";
  const windowRaw = String(formData.get("window") ?? "").trim();
  const window = windowRaw === "24h" || windowRaw === "30d" ? windowRaw : "7d";
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  try {
    const result = await runMonitorTick({
      supabase,
      orgId,
      actorUserId: userId,
      triggerSource: "manual",
      forcePlanner
    });
    revalidatePath("/app/monitor");
    revalidatePath("/app/planner");
    revalidatePath("/app/proposals");
    redirect(
      withMessage(
        "ok",
        `監視実行完了: status=${result.status} planner_invoked=${result.plannerInvoked ? "yes" : "no"} proposals=${result.createdProposals}`,
        window
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "monitor run failed";
    redirect(withMessage("error", message, window));
  }
}

export async function saveMonitorRuntimeSettings(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const windowRaw = String(formData.get("window") ?? "").trim();
  const window = windowRaw === "24h" || windowRaw === "30d" ? windowRaw : "7d";
  const before = await getOpsRuntimeSettings({ supabase, orgId });

  const payload = {
    org_id: orgId,
    monitor_stale_hours: parseIntInRange(formData.get("monitor_stale_hours"), 6, 1, 168),
    monitor_min_signal_score: parseIntInRange(formData.get("monitor_min_signal_score"), 3, 1, 999),
    monitor_planner_cooldown_minutes: parseIntInRange(formData.get("monitor_planner_cooldown_minutes"), 30, 0, 24 * 60),
    planner_proposal_dedupe_hours: parseIntInRange(formData.get("planner_proposal_dedupe_hours"), 24, 1, 24 * 14),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase.from("org_autonomy_settings").upsert(payload, { onConflict: "org_id" });
  if (error) {
    try {
      await appendAiExecutionLog({
        supabase,
        orgId,
        triggeredByUserId: userId,
        intentType: "monitor_settings_update",
        executionStatus: "failed",
        source: "planner",
        summaryText: "監視/提案の実行閾値更新に失敗",
        metadata: {
          action: "monitor_runtime_settings_update",
          error: error.message,
          attempted: payload
        },
        finishedAt: new Date().toISOString()
      });
    } catch (logError) {
      console.error(
        `[MONITOR_SETTINGS_AUDIT_LOG_FAILED] org_id=${orgId} user_id=${userId} ${
          logError instanceof Error ? logError.message : "unknown_error"
        }`
      );
    }
    redirect(withMessage("error", `設定保存に失敗しました: ${error.message}`, window));
  }

  const after = {
    monitorStaleHours: payload.monitor_stale_hours,
    monitorMinSignalScore: payload.monitor_min_signal_score,
    monitorPlannerCooldownMinutes: payload.monitor_planner_cooldown_minutes,
    plannerProposalDedupeHours: payload.planner_proposal_dedupe_hours
  };
  const changedFields = {
    monitor_stale_hours: { from: before.monitorStaleHours, to: after.monitorStaleHours },
    monitor_min_signal_score: { from: before.monitorMinSignalScore, to: after.monitorMinSignalScore },
    monitor_planner_cooldown_minutes: {
      from: before.monitorPlannerCooldownMinutes,
      to: after.monitorPlannerCooldownMinutes
    },
    planner_proposal_dedupe_hours: {
      from: before.plannerProposalDedupeHours,
      to: after.plannerProposalDedupeHours
    }
  };

  try {
    await appendAiExecutionLog({
      supabase,
      orgId,
      triggeredByUserId: userId,
      intentType: "monitor_settings_update",
      executionStatus: "done",
      source: "planner",
      summaryText: "監視/提案の実行閾値を更新",
      metadata: {
        action: "monitor_runtime_settings_update",
        changed_fields: changedFields
      },
      finishedAt: new Date().toISOString()
    });
  } catch (logError) {
    console.error(
      `[MONITOR_SETTINGS_AUDIT_LOG_FAILED] org_id=${orgId} user_id=${userId} ${
        logError instanceof Error ? logError.message : "unknown_error"
      }`
    );
  }

  revalidatePath("/app/monitor");
  revalidatePath("/app/executions");
  revalidatePath("/app/planner");
  redirect(withMessage("ok", "監視/提案の実行閾値を更新しました。", window));
}
