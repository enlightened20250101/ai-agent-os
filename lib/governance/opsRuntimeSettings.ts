import type { SupabaseClient } from "@supabase/supabase-js";

export type OpsRuntimeSettings = {
  monitorStaleHours: number;
  monitorMinSignalScore: number;
  monitorPlannerCooldownMinutes: number;
  plannerProposalDedupeHours: number;
};

const DEFAULTS: OpsRuntimeSettings = {
  monitorStaleHours: 6,
  monitorMinSignalScore: 3,
  monitorPlannerCooldownMinutes: 30,
  plannerProposalDedupeHours: 24
};

function parseEnvInt(name: string, fallback: number, min: number, max: number) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function defaultsFromEnv(): OpsRuntimeSettings {
  return {
    monitorStaleHours: parseEnvInt("MONITOR_STALE_HOURS", DEFAULTS.monitorStaleHours, 1, 168),
    monitorMinSignalScore: parseEnvInt("MONITOR_MIN_SIGNAL_SCORE", DEFAULTS.monitorMinSignalScore, 1, 999),
    monitorPlannerCooldownMinutes: parseEnvInt(
      "MONITOR_PLANNER_COOLDOWN_MINUTES",
      DEFAULTS.monitorPlannerCooldownMinutes,
      0,
      24 * 60
    ),
    plannerProposalDedupeHours: parseEnvInt(
      "PLANNER_PROPOSAL_DEDUPE_HOURS",
      DEFAULTS.plannerProposalDedupeHours,
      1,
      24 * 14
    )
  };
}

function parseDbInt(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function isMissingColumnError(message: string, columnName: string) {
  return (
    message.includes(`column "${columnName}" does not exist`) ||
    message.includes(`Could not find the '${columnName}' column`) ||
    message.includes(`column org_autonomy_settings.${columnName} does not exist`)
  );
}

function isMissingTableError(message: string) {
  return (
    message.includes('relation "org_autonomy_settings" does not exist') ||
    message.includes("Could not find the table 'public.org_autonomy_settings'")
  );
}

export async function getOpsRuntimeSettings(args: {
  supabase: SupabaseClient;
  orgId: string;
}): Promise<OpsRuntimeSettings> {
  const envDefaults = defaultsFromEnv();
  const { data, error } = await args.supabase
    .from("org_autonomy_settings")
    .select(
      "monitor_stale_hours, monitor_min_signal_score, monitor_planner_cooldown_minutes, planner_proposal_dedupe_hours"
    )
    .eq("org_id", args.orgId)
    .maybeSingle();

  if (error) {
    const message = error.message ?? "";
    if (
      isMissingTableError(message) ||
      isMissingColumnError(message, "monitor_stale_hours") ||
      isMissingColumnError(message, "monitor_min_signal_score") ||
      isMissingColumnError(message, "monitor_planner_cooldown_minutes") ||
      isMissingColumnError(message, "planner_proposal_dedupe_hours")
    ) {
      return envDefaults;
    }
    throw new Error(`ops runtime settings query failed: ${error.message}`);
  }

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    monitorStaleHours: parseDbInt(row.monitor_stale_hours, envDefaults.monitorStaleHours, 1, 168),
    monitorMinSignalScore: parseDbInt(row.monitor_min_signal_score, envDefaults.monitorMinSignalScore, 1, 999),
    monitorPlannerCooldownMinutes: parseDbInt(
      row.monitor_planner_cooldown_minutes,
      envDefaults.monitorPlannerCooldownMinutes,
      0,
      24 * 60
    ),
    plannerProposalDedupeHours: parseDbInt(
      row.planner_proposal_dedupe_hours,
      envDefaults.plannerProposalDedupeHours,
      1,
      24 * 14
    )
  };
}
