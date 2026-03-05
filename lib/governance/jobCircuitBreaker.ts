import type { SupabaseClient } from "@supabase/supabase-js";

type ResumeStage = "active" | "paused" | "dry_run";

type CircuitState = {
  consecutive_failures: number;
  paused_until: string | null;
  resume_stage: ResumeStage;
  dry_run_until: string | null;
  last_opened_at: string | null;
  manual_cleared_at: string | null;
};

type ResumeGateResult = {
  allowResume: boolean;
  reason: "manual_cleared" | "success_rate_ok" | "gate_not_met";
  successRate: number | null;
  sampleSize: number;
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

function getDryRunMinutes() {
  const raw = Number.parseInt(process.env.OPS_JOB_CIRCUIT_DRY_RUN_MINUTES ?? "10", 10);
  if (Number.isNaN(raw)) return 10;
  return Math.max(1, Math.min(24 * 60, raw));
}

function getRecheckMinutes() {
  const raw = Number.parseInt(process.env.OPS_JOB_CIRCUIT_RECHECK_MINUTES ?? "15", 10);
  if (Number.isNaN(raw)) return 15;
  return Math.max(1, Math.min(24 * 60, raw));
}

function getMinSuccessRate() {
  const raw = Number.parseFloat(process.env.OPS_JOB_CIRCUIT_MIN_SUCCESS_RATE ?? "0.6");
  if (Number.isNaN(raw)) return 0.6;
  return Math.max(0, Math.min(1, raw));
}

function getMinSampleSize() {
  const raw = Number.parseInt(process.env.OPS_JOB_CIRCUIT_MIN_SAMPLE_SIZE ?? "5", 10);
  if (Number.isNaN(raw)) return 5;
  return Math.max(1, Math.min(100, raw));
}

function isMissingTableError(message: string) {
  return (
    message.includes('relation "org_job_circuit_breakers" does not exist') ||
    message.includes("Could not find the table 'public.org_job_circuit_breakers'")
  );
}

function isMissingColumnError(message: string) {
  return message.includes("column") && message.includes("does not exist");
}

function parseStage(value: unknown): ResumeStage {
  return value === "paused" || value === "dry_run" ? value : "active";
}

async function upsertCircuitRow(args: {
  supabase: SupabaseClient;
  payload: Record<string, unknown>;
}) {
  const { supabase, payload } = args;
  const withNewCols = await supabase.from("org_job_circuit_breakers").upsert(payload, {
    onConflict: "org_id,job_name"
  });
  if (!withNewCols.error) return;
  if (!isMissingColumnError(withNewCols.error.message)) {
    throw new Error(withNewCols.error.message);
  }
  const fallbackPayload = {
    org_id: payload.org_id,
    job_name: payload.job_name,
    consecutive_failures: payload.consecutive_failures,
    paused_until: payload.paused_until,
    last_error: payload.last_error,
    last_failed_at: payload.last_failed_at,
    updated_at: payload.updated_at
  };
  const fallback = await supabase.from("org_job_circuit_breakers").upsert(fallbackPayload, {
    onConflict: "org_id,job_name"
  });
  if (fallback.error) {
    throw new Error(fallback.error.message);
  }
}

async function getState(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
}): Promise<CircuitState | null> {
  const { supabase, orgId, jobName } = args;
  const primary = await supabase
    .from("org_job_circuit_breakers")
    .select("consecutive_failures, paused_until, resume_stage, dry_run_until, last_opened_at, manual_cleared_at")
    .eq("org_id", orgId)
    .eq("job_name", jobName)
    .maybeSingle();

  if (!primary.error) {
    if (!primary.data) return null;
    return {
      consecutive_failures: Number(primary.data.consecutive_failures ?? 0),
      paused_until: (primary.data.paused_until as string | null | undefined) ?? null,
      resume_stage: parseStage(primary.data.resume_stage),
      dry_run_until: (primary.data.dry_run_until as string | null | undefined) ?? null,
      last_opened_at: (primary.data.last_opened_at as string | null | undefined) ?? null,
      manual_cleared_at: (primary.data.manual_cleared_at as string | null | undefined) ?? null
    };
  }
  if (isMissingTableError(primary.error.message)) return null;
  if (!isMissingColumnError(primary.error.message)) {
    throw new Error(`circuit state lookup failed: ${primary.error.message}`);
  }

  const fallback = await supabase
    .from("org_job_circuit_breakers")
    .select("consecutive_failures, paused_until")
    .eq("org_id", orgId)
    .eq("job_name", jobName)
    .maybeSingle();
  if (fallback.error) {
    if (isMissingTableError(fallback.error.message)) return null;
    throw new Error(`circuit fallback lookup failed: ${fallback.error.message}`);
  }
  if (!fallback.data) return null;
  return {
    consecutive_failures: Number(fallback.data.consecutive_failures ?? 0),
    paused_until: (fallback.data.paused_until as string | null | undefined) ?? null,
    resume_stage: fallback.data.paused_until ? "paused" : "active",
    dry_run_until: null,
    last_opened_at: null,
    manual_cleared_at: null
  };
}

async function canResumeByRecentSuccessRate(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
}): Promise<{ ok: boolean; successRate: number | null; sampleSize: number }> {
  const { supabase, orgId, jobName } = args;
  const minRate = getMinSuccessRate();
  const minSamples = getMinSampleSize();
  const lookbackLimit = Math.max(minSamples, 20);

  const { data, error } = await supabase
    .from("task_events")
    .select("event_type, payload_json")
    .eq("org_id", orgId)
    .in("event_type", ["OPS_JOB_RETRY_RECOVERED", "OPS_JOB_RETRY_EXHAUSTED"])
    .order("created_at", { ascending: false })
    .limit(lookbackLimit);

  if (error) {
    throw new Error(`job success-rate lookup failed: ${error.message}`);
  }

  let recovered = 0;
  let exhausted = 0;
  for (const row of data ?? []) {
    const payload = row.payload_json && typeof row.payload_json === "object" ? row.payload_json : null;
    const payloadJobName =
      payload && !Array.isArray(payload) && typeof (payload as Record<string, unknown>).job_name === "string"
        ? String((payload as Record<string, unknown>).job_name)
        : "";
    if (payloadJobName !== jobName) continue;
    if (row.event_type === "OPS_JOB_RETRY_RECOVERED") recovered += 1;
    if (row.event_type === "OPS_JOB_RETRY_EXHAUSTED") exhausted += 1;
  }

  const samples = recovered + exhausted;
  if (samples < minSamples) {
    return { ok: false, successRate: null, sampleSize: samples };
  }
  const rate = recovered / samples;
  return { ok: rate >= minRate, successRate: rate, sampleSize: samples };
}

async function evaluateResumeGate(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
  state: CircuitState;
}): Promise<ResumeGateResult> {
  const { supabase, orgId, jobName, state } = args;
  if (state.manual_cleared_at && state.last_opened_at) {
    const manualTs = new Date(state.manual_cleared_at).getTime();
    const openedTs = new Date(state.last_opened_at).getTime();
    if (Number.isFinite(manualTs) && Number.isFinite(openedTs) && manualTs >= openedTs) {
      return {
        allowResume: true,
        reason: "manual_cleared",
        successRate: null,
        sampleSize: 0
      };
    }
  }

  const successRateCheck = await canResumeByRecentSuccessRate({ supabase, orgId, jobName });
  if (successRateCheck.ok) {
    return {
      allowResume: true,
      reason: "success_rate_ok",
      successRate: successRateCheck.successRate,
      sampleSize: successRateCheck.sampleSize
    };
  }
  return {
    allowResume: false,
    reason: "gate_not_met",
    successRate: successRateCheck.successRate,
    sampleSize: successRateCheck.sampleSize
  };
}

export async function checkJobCircuitOpen(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
}): Promise<{
  open: boolean;
  pausedUntil: string | null;
  dryRun: boolean;
  gateReason?: string;
}> {
  const { supabase, orgId, jobName } = args;
  const state = await getState(args);
  if (!state) return { open: false, pausedUntil: null, dryRun: false };

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (state.resume_stage === "active") {
    return { open: false, pausedUntil: null, dryRun: false };
  }

  if (state.resume_stage === "paused") {
    const untilMs = state.paused_until ? new Date(state.paused_until).getTime() : Number.POSITIVE_INFINITY;
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      return { open: true, pausedUntil: state.paused_until, dryRun: false };
    }

    const gate = await evaluateResumeGate({ supabase, orgId, jobName, state });
    if (!gate.allowResume) {
      const nextPausedUntil = new Date(nowMs + getRecheckMinutes() * 60_000).toISOString();
      await upsertCircuitRow({
        supabase,
        payload: {
          org_id: orgId,
          job_name: jobName,
          consecutive_failures: state.consecutive_failures,
          paused_until: nextPausedUntil,
          resume_stage: "paused",
          dry_run_until: null,
          updated_at: nowIso
        }
      });
      return {
        open: true,
        pausedUntil: nextPausedUntil,
        dryRun: false,
        gateReason: `resume_gate_not_met(rate=${gate.successRate ?? "n/a"}, samples=${gate.sampleSize})`
      };
    }

    const dryRunUntil = new Date(nowMs + getDryRunMinutes() * 60_000).toISOString();
    await upsertCircuitRow({
      supabase,
      payload: {
        org_id: orgId,
        job_name: jobName,
        consecutive_failures: state.consecutive_failures,
        paused_until: null,
        resume_stage: "dry_run",
        dry_run_until: dryRunUntil,
        updated_at: nowIso
      }
    });
    return {
      open: false,
      pausedUntil: dryRunUntil,
      dryRun: true,
      gateReason: gate.reason
    };
  }

  const dryRunUntilMs = state.dry_run_until ? new Date(state.dry_run_until).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isFinite(dryRunUntilMs) && dryRunUntilMs > nowMs) {
    return { open: false, pausedUntil: state.dry_run_until, dryRun: true, gateReason: "dry_run_window" };
  }

  await upsertCircuitRow({
    supabase,
    payload: {
      org_id: orgId,
      job_name: jobName,
      consecutive_failures: 0,
      paused_until: null,
      resume_stage: "active",
      dry_run_until: null,
      updated_at: nowIso
    }
  });
  return { open: false, pausedUntil: null, dryRun: false };
}

export async function markJobCircuitDryRunPassed(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
}) {
  const { supabase, orgId, jobName } = args;
  const nowIso = new Date().toISOString();
  await upsertCircuitRow({
    supabase,
    payload: {
      org_id: orgId,
      job_name: jobName,
      resume_stage: "active",
      dry_run_until: null,
      paused_until: null,
      updated_at: nowIso
    }
  });
}

export async function recordJobCircuitManualClear(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
}) {
  const { supabase, orgId, jobName } = args;
  const state = await getState({ supabase, orgId, jobName });
  const nowIso = new Date().toISOString();
  await upsertCircuitRow({
    supabase,
    payload: {
      org_id: orgId,
      job_name: jobName,
      consecutive_failures: 0,
      paused_until: null,
      resume_stage: "active",
      dry_run_until: null,
      manual_cleared_at: nowIso,
      last_opened_at: state?.last_opened_at ?? null,
      updated_at: nowIso
    }
  });
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
    const wasPaused =
      state?.resume_stage === "paused" ||
      (state?.paused_until ? Number.isFinite(new Date(state.paused_until).getTime()) : false);
    const nowIso = new Date().toISOString();
    await upsertCircuitRow({
      supabase,
      payload: {
        org_id: orgId,
        job_name: jobName,
        consecutive_failures: 0,
        paused_until: null,
        resume_stage: "active",
        dry_run_until: null,
        last_error: null,
        updated_at: nowIso
      }
    });
    return { closed: Boolean(wasPaused), hadFailures };
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

  try {
    await upsertCircuitRow({
      supabase,
      payload: {
        org_id: orgId,
        job_name: jobName,
        consecutive_failures: nextFailures,
        paused_until: pausedUntil,
        resume_stage: shouldOpen ? "paused" : "active",
        dry_run_until: null,
        last_error: errorMessage.slice(0, 1000),
        last_failed_at: nowIso,
        last_opened_at: shouldOpen ? nowIso : state?.last_opened_at ?? null,
        updated_at: nowIso
      }
    });
  } catch (error) {
    if (error instanceof Error && isMissingTableError(error.message)) {
      return { opened: false, pausedUntil: null, consecutiveFailures: nextFailures };
    }
    throw error;
  }

  return { opened: shouldOpen, pausedUntil, consecutiveFailures: nextFailures };
}
