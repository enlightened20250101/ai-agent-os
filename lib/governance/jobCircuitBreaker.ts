import type { SupabaseClient } from "@supabase/supabase-js";

type CircuitState = {
  consecutive_failures: number;
  paused_until: string | null;
};

function getThreshold() {
  const raw = Number.parseInt(process.env.OPS_JOB_CIRCUIT_BREAKER_THRESHOLD ?? "3", 10);
  if (Number.isNaN(raw)) return 3;
  return Math.max(1, Math.min(20, raw));
}

function getPauseMinutes() {
  const raw = Number.parseInt(process.env.OPS_JOB_CIRCUIT_BREAKER_PAUSE_MINUTES ?? "30", 10);
  if (Number.isNaN(raw)) return 30;
  return Math.max(1, Math.min(24 * 60, raw));
}

function isMissingTableError(message: string) {
  return (
    message.includes('relation "org_job_circuit_breakers" does not exist') ||
    message.includes("Could not find the table 'public.org_job_circuit_breakers'")
  );
}

async function getState(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
}): Promise<CircuitState | null> {
  const { supabase, orgId, jobName } = args;
  const { data, error } = await supabase
    .from("org_job_circuit_breakers")
    .select("consecutive_failures, paused_until")
    .eq("org_id", orgId)
    .eq("job_name", jobName)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error.message)) return null;
    throw new Error(`circuit state lookup failed: ${error.message}`);
  }
  if (!data) return null;
  return {
    consecutive_failures: Number(data.consecutive_failures ?? 0),
    paused_until: (data.paused_until as string | null | undefined) ?? null
  };
}

export async function checkJobCircuitOpen(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
}): Promise<{ open: boolean; pausedUntil: string | null }> {
  const state = await getState(args);
  if (!state?.paused_until) return { open: false, pausedUntil: null };
  const untilMs = new Date(state.paused_until).getTime();
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
    return { open: false, pausedUntil: null };
  }
  return { open: true, pausedUntil: state.paused_until };
}

export async function recordJobCircuitSuccess(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
}): Promise<{ closed: boolean; hadFailures: boolean }> {
  const { supabase, orgId, jobName } = args;
  try {
    const state = await getState({ supabase, orgId, jobName });
    const hadFailures = Number(state?.consecutive_failures ?? 0) > 0;
    const wasPaused = Boolean(state?.paused_until && new Date(state.paused_until).getTime() > Date.now());
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from("org_job_circuit_breakers").upsert(
      {
        org_id: orgId,
        job_name: jobName,
        consecutive_failures: 0,
        paused_until: null,
        last_error: null,
        updated_at: nowIso
      },
      { onConflict: "org_id,job_name" }
    );
    if (error && !isMissingTableError(error.message)) {
      throw new Error(error.message);
    }
    return { closed: wasPaused, hadFailures };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[OPS_JOB_CIRCUIT_SUCCESS_UPDATE_ERROR] org_id=${orgId} job=${jobName} ${message}`);
    return { closed: false, hadFailures: false };
  }
}

export async function recordJobCircuitFailure(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
  errorMessage: string;
}): Promise<{ opened: boolean; pausedUntil: string | null; consecutiveFailures: number }> {
  const { supabase, orgId, jobName, errorMessage } = args;
  const threshold = getThreshold();
  const pauseMinutes = getPauseMinutes();
  const state = await getState({ supabase, orgId, jobName });

  const nextFailures = (state?.consecutive_failures ?? 0) + 1;
  const shouldOpen = nextFailures >= threshold;
  const pausedUntil = shouldOpen ? new Date(Date.now() + pauseMinutes * 60_000).toISOString() : null;
  const nowIso = new Date().toISOString();

  const { error } = await supabase.from("org_job_circuit_breakers").upsert(
    {
      org_id: orgId,
      job_name: jobName,
      consecutive_failures: nextFailures,
      paused_until: pausedUntil,
      last_error: errorMessage.slice(0, 1000),
      last_failed_at: nowIso,
      updated_at: nowIso
    },
    { onConflict: "org_id,job_name" }
  );
  if (error) {
    if (isMissingTableError(error.message)) {
      return { opened: false, pausedUntil: null, consecutiveFailures: nextFailures };
    }
    throw new Error(`circuit failure update failed: ${error.message}`);
  }

  return { opened: shouldOpen, pausedUntil, consecutiveFailures: nextFailures };
}
