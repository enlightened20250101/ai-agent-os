import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkJobCircuitOpen,
  markJobCircuitDryRunPassed,
  recordJobCircuitFailure,
  recordJobCircuitSuccess
} from "@/lib/governance/jobCircuitBreaker";
import { maybeSendJobCircuitAlert } from "@/lib/governance/opsAlerts";
import { getOrCreateGovernanceOpsTaskId } from "@/lib/governance/review";

type RetryResult<T> =
  | {
      ok: true;
      value: T;
      attempts: number;
      retried: boolean;
    }
  | {
      ok: false;
      error: string;
      attempts: number;
      retried: boolean;
      circuitOpen: boolean;
      pausedUntil: string | null;
      dryRunProbe: boolean;
    };

function getRetryConfig() {
  const maxAttemptsRaw = Number.parseInt(process.env.OPS_JOB_RETRY_MAX_ATTEMPTS ?? "2", 10);
  const maxAttempts = Number.isNaN(maxAttemptsRaw) ? 2 : Math.max(1, Math.min(5, maxAttemptsRaw));
  const backoffMsRaw = Number.parseInt(process.env.OPS_JOB_RETRY_BACKOFF_MS ?? "500", 10);
  const backoffMs = Number.isNaN(backoffMsRaw) ? 500 : Math.max(100, Math.min(10000, backoffMsRaw));
  return { maxAttempts, backoffMs };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logRetryEvent(args: {
  supabase: SupabaseClient;
  orgId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const { supabase, orgId, eventType, payload } = args;
  try {
    const taskId = await getOrCreateGovernanceOpsTaskId({ supabase, orgId });
    await supabase.from("task_events").insert({
      org_id: orgId,
      task_id: taskId,
      actor_type: "system",
      actor_id: null,
      event_type: eventType,
      payload_json: payload
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[OPS_JOB_RETRY_EVENT_LOG_ERROR] org_id=${orgId} event_type=${eventType} ${message}`);
  }
}

export async function runWithOpsRetry<T>(args: {
  supabase: SupabaseClient;
  orgId: string;
  jobName: string;
  run: () => Promise<T>;
  runDryProbe?: () => Promise<void>;
}): Promise<RetryResult<T>> {
  const { supabase, orgId, jobName, run, runDryProbe } = args;
  const circuit = await checkJobCircuitOpen({ supabase, orgId, jobName });
  if (circuit.open) {
    await logRetryEvent({
      supabase,
      orgId,
      eventType: "OPS_JOB_SKIPPED_CIRCUIT_OPEN",
      payload: {
        job_name: jobName,
        paused_until: circuit.pausedUntil,
        reason: circuit.gateReason ?? null
      }
    });
    return {
      ok: false,
      error: `circuit_open_until:${circuit.pausedUntil ?? "unknown"}`,
      attempts: 0,
      retried: false,
      circuitOpen: true,
      pausedUntil: circuit.pausedUntil,
      dryRunProbe: false
    };
  }
  if (circuit.dryRun) {
    try {
      if (runDryProbe) {
        await runDryProbe();
      } else {
        await supabase.from("orgs").select("id").eq("id", orgId).limit(1).single();
      }
      await markJobCircuitDryRunPassed({ supabase, orgId, jobName });
      await logRetryEvent({
        supabase,
        orgId,
        eventType: "OPS_JOB_DRY_RUN_PASSED",
        payload: {
          job_name: jobName,
          dry_run_until: circuit.pausedUntil,
          reason: circuit.gateReason ?? null
        }
      });
      return {
        ok: false,
        error: "dry_run_probe_passed",
        attempts: 0,
        retried: false,
        circuitOpen: false,
        pausedUntil: circuit.pausedUntil,
        dryRunProbe: true
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "dry run probe failed";
      const circuitResult = await recordJobCircuitFailure({
        supabase,
        orgId,
        jobName,
        errorMessage: `dry_run_probe_failed:${message}`
      });
      await logRetryEvent({
        supabase,
        orgId,
        eventType: "OPS_JOB_DRY_RUN_FAILED",
        payload: {
          job_name: jobName,
          error: message,
          paused_until: circuitResult.pausedUntil,
          consecutive_failures: circuitResult.consecutiveFailures
        }
      });
      return {
        ok: false,
        error: message,
        attempts: 0,
        retried: false,
        circuitOpen: true,
        pausedUntil: circuitResult.pausedUntil,
        dryRunProbe: false
      };
    }
  }

  const { maxAttempts, backoffMs } = getRetryConfig();

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await run();
      if (attempt > 1) {
        await logRetryEvent({
          supabase,
          orgId,
          eventType: "OPS_JOB_RETRY_RECOVERED",
          payload: {
            job_name: jobName,
            attempts: attempt,
            retries: attempt - 1
          }
        });
      }
      const circuitSuccess = await recordJobCircuitSuccess({ supabase, orgId, jobName });
      if (circuitSuccess.closed || circuitSuccess.hadFailures) {
        await logRetryEvent({
          supabase,
          orgId,
          eventType: "OPS_JOB_CIRCUIT_CLOSED",
          payload: {
            job_name: jobName,
            reason: circuitSuccess.closed ? "pause_expired_or_recovered" : "failure_counter_reset_on_success",
            attempts: attempt
          }
        });
      }
      return {
        ok: true,
        value,
        attempts: attempt,
        retried: attempt > 1
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
      const willRetry = attempt < maxAttempts;
      if (willRetry) {
        const waitMs = backoffMs * attempt;
        await logRetryEvent({
          supabase,
          orgId,
          eventType: "OPS_JOB_RETRY_SCHEDULED",
          payload: {
            job_name: jobName,
            attempt,
            max_attempts: maxAttempts,
            wait_ms: waitMs,
            error: lastError
          }
        });
        await delay(waitMs);
      } else {
        const circuitResult = await recordJobCircuitFailure({
          supabase,
          orgId,
          jobName,
          errorMessage: lastError
        });
        await logRetryEvent({
          supabase,
          orgId,
          eventType: "OPS_JOB_RETRY_EXHAUSTED",
          payload: {
            job_name: jobName,
            attempts: attempt,
            max_attempts: maxAttempts,
            error: lastError,
            circuit_opened: circuitResult.opened,
            paused_until: circuitResult.pausedUntil,
            consecutive_failures: circuitResult.consecutiveFailures
          }
        });
        if (circuitResult.opened) {
          await logRetryEvent({
            supabase,
            orgId,
            eventType: "OPS_JOB_CIRCUIT_OPENED",
            payload: {
              job_name: jobName,
              paused_until: circuitResult.pausedUntil,
              consecutive_failures: circuitResult.consecutiveFailures
            }
          });
          try {
            await maybeSendJobCircuitAlert({
              supabase,
              orgId,
              jobName,
              pausedUntil: circuitResult.pausedUntil,
              consecutiveFailures: circuitResult.consecutiveFailures
            });
          } catch (alertError) {
            const message = alertError instanceof Error ? alertError.message : "unknown alert error";
            console.error(`[OPS_JOB_CIRCUIT_ALERT_ERROR] org_id=${orgId} job=${jobName} ${message}`);
          }
        }
      }
    }
  }

  return {
    ok: false,
    error: lastError,
    attempts: maxAttempts,
    retried: maxAttempts > 1,
    circuitOpen: false,
    pausedUntil: null,
    dryRunProbe: false
  };
}
