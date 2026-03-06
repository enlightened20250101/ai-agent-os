import type { SupabaseClient } from "@supabase/supabase-js";
import { getOpsRuntimeSettings } from "@/lib/governance/opsRuntimeSettings";
import { getLatestOpenIncident } from "@/lib/governance/incidents";
import { runWithOpsRetry } from "@/lib/governance/jobRetry";
import { postMonitorNudgeToSharedChat } from "@/lib/monitor/chatNudges";
import { runPlanner } from "@/lib/planner/runPlanner";

type MonitorTriggerSource = "manual" | "api" | "cron";

type RunMonitorArgs = {
  supabase: SupabaseClient;
  orgId: string;
  actorUserId?: string | null;
  triggerSource?: MonitorTriggerSource;
  forcePlanner?: boolean;
};

type SignalCounts = {
  stale_tasks: number;
  stale_pending_approvals: number;
  recent_action_failures: number;
  stale_open_cases: number;
  policy_warn_block_24h: number;
  new_inbound_events_24h: number;
};

type SignalSamples = {
  stale_tasks: Array<{ id: string; title: string }>;
  stale_approval_task_ids: string[];
  failed_action_task_ids: string[];
  stale_cases: Array<{ id: string; title: string }>;
  policy_warn_block_task_ids: string[];
  new_inbound_events: Array<{ id: string; provider: string; event_type: string; summary: string | null }>;
};

type RunMonitorResult = {
  monitorRunId: string;
  plannerInvoked: boolean;
  plannerRunId: string | null;
  createdProposals: number;
  signalCounts: SignalCounts;
  signalSamples: SignalSamples;
  status: "completed" | "skipped" | "failed";
};

type PlannerDecision = {
  shouldInvokePlanner: boolean;
  reason:
    | "force_planner"
    | "signals_met"
    | "no_signals"
    | "incident_open"
    | "below_score_threshold"
    | "planner_cooldown";
  signalScore: number;
  minRequiredScore: number;
  cooldownMinutes: number;
  cooldownUntil: string | null;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

async function appendMonitorProposalEvent(args: {
  supabase: SupabaseClient;
  orgId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const { error } = await args.supabase.from("proposal_events").insert({
    org_id: args.orgId,
    proposal_id: null,
    event_type: args.eventType,
    payload_json: args.payload
  });
  if (error) {
    if (isMissingTableError(error.message, "proposal_events")) {
      return;
    }
    throw new Error(`monitor proposal event insert failed: ${error.message}`);
  }
}

async function collectSignalCounts(args: { supabase: SupabaseClient; orgId: string; staleHours: number }) {
  const { supabase, orgId } = args;
  const staleHours = Math.max(1, Math.min(168, args.staleHours));
  const staleCutoffIso = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
  const last24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [staleTasksRes, staleApprovalsRes, failedEventsRes, staleCasesRes, policyEventsRes, inboundEventsRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .in("status", ["draft", "ready_for_approval"])
      .lt("created_at", staleCutoffIso),
    supabase
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending")
      .lt("created_at", staleCutoffIso),
    supabase
      .from("task_events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("event_type", "ACTION_FAILED")
      .gte("created_at", last24hIso),
    supabase
      .from("business_cases")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "open")
      .lt("updated_at", staleCutoffIso),
    supabase
      .from("task_events")
      .select("payload_json, created_at")
      .eq("org_id", orgId)
      .eq("event_type", "POLICY_CHECKED")
      .gte("created_at", last24hIso)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("external_events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "new")
      .gte("created_at", last24hIso)
  ]);
  const [staleTasksSampleRes, staleApprovalsSampleRes, failedEventsSampleRes, staleCasesSampleRes, policyEventsSampleRes, inboundEventsSampleRes] =
    await Promise.all([
    supabase
      .from("tasks")
      .select("id, title")
      .eq("org_id", orgId)
      .in("status", ["draft", "ready_for_approval"])
      .lt("created_at", staleCutoffIso)
      .order("created_at", { ascending: true })
      .limit(5),
    supabase
      .from("approvals")
      .select("task_id")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .lt("created_at", staleCutoffIso)
      .order("created_at", { ascending: true })
      .limit(5),
    supabase
      .from("task_events")
      .select("task_id")
      .eq("org_id", orgId)
      .eq("event_type", "ACTION_FAILED")
      .gte("created_at", last24hIso)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("business_cases")
      .select("id, title")
      .eq("org_id", orgId)
      .eq("status", "open")
      .lt("updated_at", staleCutoffIso)
      .order("updated_at", { ascending: true })
      .limit(5),
    supabase
      .from("task_events")
      .select("task_id, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "POLICY_CHECKED")
      .gte("created_at", last24hIso)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("external_events")
      .select("id, provider, event_type, summary_text")
      .eq("org_id", orgId)
      .eq("status", "new")
      .gte("created_at", last24hIso)
      .order("created_at", { ascending: false })
      .limit(5)
    ]);

  if (staleTasksRes.error) throw new Error(`monitor stale_tasks query failed: ${staleTasksRes.error.message}`);
  if (staleApprovalsRes.error) throw new Error(`monitor stale_approvals query failed: ${staleApprovalsRes.error.message}`);
  if (failedEventsRes.error) throw new Error(`monitor failed_events query failed: ${failedEventsRes.error.message}`);
  if (staleCasesRes.error && !isMissingTableError(staleCasesRes.error.message, "business_cases")) {
    throw new Error(`monitor stale_cases query failed: ${staleCasesRes.error.message}`);
  }
  if (policyEventsRes.error) throw new Error(`monitor policy query failed: ${policyEventsRes.error.message}`);
  if (inboundEventsRes.error && !isMissingTableError(inboundEventsRes.error.message, "external_events")) {
    throw new Error(`monitor inbound events query failed: ${inboundEventsRes.error.message}`);
  }
  if (staleTasksSampleRes.error) throw new Error(`monitor stale task sample query failed: ${staleTasksSampleRes.error.message}`);
  if (staleApprovalsSampleRes.error) throw new Error(`monitor stale approval sample query failed: ${staleApprovalsSampleRes.error.message}`);
  if (failedEventsSampleRes.error) throw new Error(`monitor failed event sample query failed: ${failedEventsSampleRes.error.message}`);
  if (staleCasesSampleRes.error && !isMissingTableError(staleCasesSampleRes.error.message, "business_cases")) {
    throw new Error(`monitor stale case sample query failed: ${staleCasesSampleRes.error.message}`);
  }
  if (policyEventsSampleRes.error) throw new Error(`monitor policy sample query failed: ${policyEventsSampleRes.error.message}`);
  if (inboundEventsSampleRes.error && !isMissingTableError(inboundEventsSampleRes.error.message, "external_events")) {
    throw new Error(`monitor inbound sample query failed: ${inboundEventsSampleRes.error.message}`);
  }

  const policyWarnBlock = (policyEventsRes.data ?? []).filter((row) => {
    const payload =
      typeof row.payload_json === "object" && row.payload_json !== null
        ? (row.payload_json as Record<string, unknown>)
        : null;
    return payload?.status === "warn" || payload?.status === "block";
  }).length;

  const signalCounts: SignalCounts = {
    stale_tasks: staleTasksRes.count ?? 0,
    stale_pending_approvals: staleApprovalsRes.count ?? 0,
    recent_action_failures: failedEventsRes.count ?? 0,
    stale_open_cases: staleCasesRes.error ? 0 : (staleCasesRes.count ?? 0),
    policy_warn_block_24h: policyWarnBlock,
    new_inbound_events_24h: inboundEventsRes.error ? 0 : (inboundEventsRes.count ?? 0)
  };
  const policySampleTaskIds = Array.from(
    new Set(
      (policyEventsSampleRes.data ?? [])
        .filter((row) => {
          const payload =
            typeof row.payload_json === "object" && row.payload_json !== null
              ? (row.payload_json as Record<string, unknown>)
              : null;
          return payload?.status === "warn" || payload?.status === "block";
        })
        .map((row) => (row.task_id as string | null) ?? null)
        .filter((taskId): taskId is string => Boolean(taskId))
    )
  ).slice(0, 5);
  const signalSamples: SignalSamples = {
    stale_tasks: (staleTasksSampleRes.data ?? [])
      .map((row) => {
        const id = (row.id as string | null) ?? null;
        const title = (row.title as string | null) ?? null;
        if (!id || !title) return null;
        return { id, title };
      })
      .filter((item): item is { id: string; title: string } => item !== null)
      .slice(0, 5),
    stale_approval_task_ids: Array.from(
      new Set(
        (staleApprovalsSampleRes.data ?? [])
          .map((row) => (row.task_id as string | null) ?? null)
          .filter((taskId): taskId is string => Boolean(taskId))
      )
    ).slice(0, 5),
    failed_action_task_ids: Array.from(
      new Set(
        (failedEventsSampleRes.data ?? [])
          .map((row) => (row.task_id as string | null) ?? null)
          .filter((taskId): taskId is string => Boolean(taskId))
      )
    ).slice(0, 5),
    stale_cases: (staleCasesSampleRes.error ? [] : (staleCasesSampleRes.data ?? []))
      .map((row) => {
        const id = (row.id as string | null) ?? null;
        const title = (row.title as string | null) ?? null;
        if (!id || !title) return null;
        return { id, title };
      })
      .filter((item): item is { id: string; title: string } => item !== null)
      .slice(0, 5),
    policy_warn_block_task_ids: policySampleTaskIds,
    new_inbound_events: (inboundEventsSampleRes.error ? [] : (inboundEventsSampleRes.data ?? []))
      .map((row) => ({
        id: (row.id as string | null) ?? "",
        provider: (row.provider as string | null) ?? "",
        event_type: (row.event_type as string | null) ?? "",
        summary: (row.summary_text as string | null) ?? null
      }))
      .filter((row) => Boolean(row.id) && Boolean(row.provider) && Boolean(row.event_type))
  };
  return { signalCounts, signalSamples, staleHours };
}

function resolveSignalWeights() {
  const read = (key: string, fallback: number) => {
    const raw = Number.parseInt(process.env[key] ?? "", 10);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(1, Math.min(10, raw));
  };
  return {
    stale_tasks: read("MONITOR_WEIGHT_STALE_TASKS", 2),
    stale_pending_approvals: read("MONITOR_WEIGHT_STALE_PENDING_APPROVALS", 2),
    recent_action_failures: read("MONITOR_WEIGHT_RECENT_ACTION_FAILURES", 3),
    stale_open_cases: read("MONITOR_WEIGHT_STALE_OPEN_CASES", 2),
    policy_warn_block_24h: read("MONITOR_WEIGHT_POLICY_WARN_BLOCK", 2),
    new_inbound_events_24h: read("MONITOR_WEIGHT_NEW_INBOUND_EVENTS", 1)
  } as const;
}

function computeSignalScore(signalCounts: SignalCounts) {
  const w = resolveSignalWeights();
  return (
    signalCounts.stale_tasks * w.stale_tasks +
    signalCounts.stale_pending_approvals * w.stale_pending_approvals +
    signalCounts.recent_action_failures * w.recent_action_failures +
    signalCounts.stale_open_cases * w.stale_open_cases +
    signalCounts.policy_warn_block_24h * w.policy_warn_block_24h +
    signalCounts.new_inbound_events_24h * w.new_inbound_events_24h
  );
}

async function decidePlannerInvocation(args: {
  supabase: SupabaseClient;
  orgId: string;
  forcePlanner: boolean;
  totalSignals: number;
  signalScore: number;
  minRequiredScore: number;
  cooldownMinutes: number;
  latestOpenIncident: { id: string; severity: string } | null;
}) : Promise<PlannerDecision> {
  const minRequiredScore = args.minRequiredScore;
  const cooldownMinutes = args.cooldownMinutes;

  if (args.latestOpenIncident) {
    return {
      shouldInvokePlanner: false,
      reason: "incident_open",
      signalScore: args.signalScore,
      minRequiredScore,
      cooldownMinutes,
      cooldownUntil: null
    };
  }
  if (args.forcePlanner) {
    return {
      shouldInvokePlanner: true,
      reason: "force_planner",
      signalScore: args.signalScore,
      minRequiredScore,
      cooldownMinutes,
      cooldownUntil: null
    };
  }
  if (args.totalSignals <= 0) {
    return {
      shouldInvokePlanner: false,
      reason: "no_signals",
      signalScore: args.signalScore,
      minRequiredScore,
      cooldownMinutes,
      cooldownUntil: null
    };
  }
  if (args.signalScore < minRequiredScore) {
    return {
      shouldInvokePlanner: false,
      reason: "below_score_threshold",
      signalScore: args.signalScore,
      minRequiredScore,
      cooldownMinutes,
      cooldownUntil: null
    };
  }
  if (cooldownMinutes > 0) {
    const cooldownFromIso = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
    const { data: latestPlannerMonitorRun, error } = await args.supabase
      .from("monitor_runs")
      .select("created_at")
      .eq("org_id", args.orgId)
      .eq("planner_invoked", true)
      .in("status", ["completed", "running"])
      .gte("created_at", cooldownFromIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`monitor cooldown query failed: ${error.message}`);
    }
    if (latestPlannerMonitorRun?.created_at) {
      const cooldownUntil = new Date(
        new Date(latestPlannerMonitorRun.created_at as string).getTime() + cooldownMinutes * 60 * 1000
      ).toISOString();
      return {
        shouldInvokePlanner: false,
        reason: "planner_cooldown",
        signalScore: args.signalScore,
        minRequiredScore,
        cooldownMinutes,
        cooldownUntil
      };
    }
  }

  return {
    shouldInvokePlanner: true,
    reason: "signals_met",
    signalScore: args.signalScore,
    minRequiredScore,
    cooldownMinutes,
    cooldownUntil: null
  };
}

export async function runMonitorTick(args: RunMonitorArgs): Promise<RunMonitorResult> {
  const { supabase, orgId, actorUserId = null, triggerSource = "manual", forcePlanner = false } = args;
  const runtime = await getOpsRuntimeSettings({ supabase, orgId });
  const { signalCounts, signalSamples, staleHours } = await collectSignalCounts({
    supabase,
    orgId,
    staleHours: runtime.monitorStaleHours
  });
  const latestOpenIncident = await getLatestOpenIncident({ supabase, orgId });
  const totalSignals = Object.values(signalCounts).reduce((sum, value) => sum + value, 0);
  const signalScore = computeSignalScore(signalCounts);
  const plannerDecision = await decidePlannerInvocation({
    supabase,
    orgId,
    forcePlanner,
    totalSignals,
    signalScore,
    minRequiredScore: runtime.monitorMinSignalScore,
    cooldownMinutes: runtime.monitorPlannerCooldownMinutes,
    latestOpenIncident: latestOpenIncident
      ? { id: latestOpenIncident.id, severity: latestOpenIncident.severity }
      : null
  });
  const shouldInvokePlanner = plannerDecision.shouldInvokePlanner;

  const { data: monitorRun, error: monitorRunError } = await supabase
    .from("monitor_runs")
    .insert({
      org_id: orgId,
      trigger_source: triggerSource,
      status: "running",
      planner_invoked: false,
      signal_counts_json: signalCounts,
      summary_json: {
        stale_hours: staleHours,
        total_signals: totalSignals,
        signal_score: signalScore,
        min_required_score: plannerDecision.minRequiredScore,
        planner_cooldown_minutes: plannerDecision.cooldownMinutes,
        should_invoke_planner: shouldInvokePlanner,
        decision_reason: plannerDecision.reason,
        cooldown_until: plannerDecision.cooldownUntil,
        signal_samples: signalSamples
      }
    })
    .select("id")
    .single();

  if (monitorRunError) {
    if (isMissingTableError(monitorRunError.message, "monitor_runs")) {
      throw new Error("monitor_runs migration is not applied. Run `supabase db push`.");
    }
    throw new Error(`monitor run insert failed: ${monitorRunError.message}`);
  }
  const monitorRunId = monitorRun.id as string;
  await appendMonitorProposalEvent({
    supabase,
    orgId,
    eventType: "MONITOR_DECISION_RECORDED",
    payload: {
      monitor_run_id: monitorRunId,
      trigger_source: triggerSource,
      decision_reason: plannerDecision.reason,
      should_invoke_planner: shouldInvokePlanner,
      signal_score: signalScore,
      min_required_score: plannerDecision.minRequiredScore,
      planner_cooldown_minutes: plannerDecision.cooldownMinutes,
      cooldown_until: plannerDecision.cooldownUntil,
      total_signals: totalSignals,
      signal_counts: signalCounts,
      blocked_by_incident: Boolean(latestOpenIncident),
      incident_id: latestOpenIncident?.id ?? null,
      incident_severity: latestOpenIncident?.severity ?? null
    }
  });

  if (!shouldInvokePlanner) {
    const skipReason = plannerDecision.reason;
    const shouldPostSkipNudge = skipReason === "incident_open";
    const nudge = shouldPostSkipNudge
      ? await postMonitorNudgeToSharedChat({
          supabase,
          orgId,
          monitorRunId,
          signalCounts,
          signalSamples,
          plannerInvoked: false,
          createdProposals: 0,
          status: "skipped",
          errorMessage: latestOpenIncident
            ? `インシデントモード中のため planner 起動を停止しました（severity=${latestOpenIncident.severity}）。`
            : undefined
        })
      : { posted: false, reason: "skip_nudge_suppressed" as const };
    await supabase
      .from("monitor_runs")
      .update({
        status: "skipped",
        planner_invoked: false,
        summary_json: {
          stale_hours: staleHours,
          total_signals: totalSignals,
          signal_score: signalScore,
          min_required_score: plannerDecision.minRequiredScore,
          planner_cooldown_minutes: plannerDecision.cooldownMinutes,
          should_invoke_planner: false,
          reason: skipReason,
          decision_reason: plannerDecision.reason,
          cooldown_until: plannerDecision.cooldownUntil,
          blocked_by_incident: Boolean(latestOpenIncident),
          incident_id: latestOpenIncident?.id ?? null,
          incident_severity: latestOpenIncident?.severity ?? null,
          chat_nudge_posted: nudge.posted,
          chat_nudge_reason: nudge.reason,
          signal_samples: signalSamples
        },
        finished_at: new Date().toISOString()
      })
      .eq("org_id", orgId)
      .eq("id", monitorRunId);
    await appendMonitorProposalEvent({
      supabase,
      orgId,
      eventType: "MONITOR_TICK_FINISHED",
      payload: {
        monitor_run_id: monitorRunId,
        status: "skipped",
        decision_reason: plannerDecision.reason,
        planner_invoked: false,
        created_proposals: 0,
        signal_score: signalScore
      }
    });
    return {
      monitorRunId,
      plannerInvoked: false,
      plannerRunId: null,
      createdProposals: 0,
      signalCounts,
      signalSamples,
      status: "skipped"
    };
  }

  const retried = await runWithOpsRetry({
    supabase,
    orgId,
    jobName: "monitor_planner_tick",
    run: async () =>
      runPlanner({
        supabase,
        orgId,
        actorUserId,
        maxProposals: 3
      })
  });

  if (!retried.ok) {
    const nudge = await postMonitorNudgeToSharedChat({
      supabase,
      orgId,
      monitorRunId,
      signalCounts,
      signalSamples,
      plannerInvoked: true,
      createdProposals: 0,
      status: "failed",
      errorMessage: retried.error
    });
    await supabase
      .from("monitor_runs")
      .update({
        status: "failed",
        planner_invoked: true,
        summary_json: {
          stale_hours: staleHours,
          total_signals: totalSignals,
          signal_score: signalScore,
          min_required_score: plannerDecision.minRequiredScore,
          planner_cooldown_minutes: plannerDecision.cooldownMinutes,
          should_invoke_planner: true,
          decision_reason: plannerDecision.reason,
          retry_attempts: retried.attempts,
          error: retried.error,
          skipped_circuit: retried.circuitOpen,
          skipped_dry_run: retried.dryRunProbe,
          chat_nudge_posted: nudge.posted,
          chat_nudge_reason: nudge.reason,
          signal_samples: signalSamples
        },
        finished_at: new Date().toISOString()
      })
      .eq("org_id", orgId)
      .eq("id", monitorRunId);
    await appendMonitorProposalEvent({
      supabase,
      orgId,
      eventType: "MONITOR_TICK_FINISHED",
      payload: {
        monitor_run_id: monitorRunId,
        status: "failed",
        decision_reason: plannerDecision.reason,
        planner_invoked: true,
        created_proposals: 0,
        signal_score: signalScore,
        error: retried.error
      }
    });
    return {
      monitorRunId,
      plannerInvoked: true,
      plannerRunId: null,
      createdProposals: 0,
      signalCounts,
      signalSamples,
      status: "failed"
    };
  }

  const nudge = await postMonitorNudgeToSharedChat({
    supabase,
    orgId,
    monitorRunId,
      signalCounts,
      signalSamples,
      plannerInvoked: true,
    createdProposals: retried.value.createdProposals,
    status: "completed"
  });
  await supabase
    .from("monitor_runs")
    .update({
      status: "completed",
      planner_invoked: true,
      planner_run_id: retried.value.plannerRunId,
      summary_json: {
        stale_hours: staleHours,
        total_signals: totalSignals,
        signal_score: signalScore,
        min_required_score: plannerDecision.minRequiredScore,
        planner_cooldown_minutes: plannerDecision.cooldownMinutes,
        should_invoke_planner: true,
        decision_reason: plannerDecision.reason,
        retry_attempts: retried.attempts,
        created_proposals: retried.value.createdProposals,
        considered_signals: retried.value.consideredSignals,
        chat_nudge_posted: nudge.posted,
        chat_nudge_reason: nudge.reason,
        signal_samples: signalSamples
      },
      finished_at: new Date().toISOString()
    })
    .eq("org_id", orgId)
    .eq("id", monitorRunId);
  await appendMonitorProposalEvent({
    supabase,
    orgId,
    eventType: "MONITOR_TICK_FINISHED",
    payload: {
      monitor_run_id: monitorRunId,
      status: "completed",
      decision_reason: plannerDecision.reason,
      planner_invoked: true,
      planner_run_id: retried.value.plannerRunId,
      created_proposals: retried.value.createdProposals,
      considered_signals: retried.value.consideredSignals,
      signal_score: signalScore
    }
  });

  return {
    monitorRunId,
    plannerInvoked: true,
    plannerRunId: retried.value.plannerRunId,
    createdProposals: retried.value.createdProposals,
    signalCounts,
    signalSamples,
    status: "completed"
  };
}
