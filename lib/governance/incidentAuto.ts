import type { SupabaseClient } from "@supabase/supabase-js";
import { appendTaskEvent, getOrCreateAgentOpsTaskId } from "@/lib/events/taskEvents";

type AutoIncidentArgs = {
  supabase: SupabaseClient;
  orgId: string;
  actorUserId?: string | null;
  source?: "manual" | "cron" | "review";
};

type AutoIncidentResult = {
  evaluated: boolean;
  opened: boolean;
  reason: string;
  incidentId?: string;
  trigger?: string;
  metrics?: {
    plannerConsecutiveFailed: number;
    reviewConsecutiveFailed: number;
    actionFailedCount: number;
    lookbackHours: number;
  };
};

function envBool(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (Number.isNaN(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function isMissingTable(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function consecutiveFailuresByStatus(rows: Array<{ status: string | null }>) {
  let count = 0;
  for (const row of rows) {
    if (row.status === "failed") count += 1;
    else break;
  }
  return count;
}

function consecutiveFailuresByEvent(rows: Array<{ event_type: string | null }>, failedType: string) {
  let count = 0;
  for (const row of rows) {
    if (row.event_type === failedType) count += 1;
    else break;
  }
  return count;
}

async function resolveFallbackActorUserId(args: { supabase: SupabaseClient; orgId: string }) {
  const { data, error } = await args.supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", args.orgId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return null;
  }
  return (data?.user_id as string | undefined) ?? null;
}

export async function evaluateAndMaybeOpenIncident({
  supabase,
  orgId,
  actorUserId = null,
  source = "cron"
}: AutoIncidentArgs): Promise<AutoIncidentResult> {
  const enabled = envBool("INCIDENT_AUTO_OPEN_ENABLED", false);
  if (!enabled) {
    return {
      evaluated: false,
      opened: false,
      reason: "disabled"
    };
  }

  const failThreshold = envInt("INCIDENT_AUTO_FAIL_THRESHOLD", 3, 2, 20);
  const actionFailedThreshold = envInt("INCIDENT_AUTO_ACTION_FAILED_THRESHOLD", 5, 1, 100);
  const lookbackHours = envInt("INCIDENT_AUTO_LOOKBACK_HOURS", 6, 1, 72);
  const lookbackIso = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const [openIncidentsRes, plannerRunsRes, reviewEventsRes, actionFailedRes] = await Promise.all([
    supabase.from("org_incidents").select("id").eq("org_id", orgId).eq("status", "open").limit(1).maybeSingle(),
    supabase
      .from("planner_runs")
      .select("status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("task_events")
      .select("event_type, created_at")
      .eq("org_id", orgId)
      .in("event_type", ["GOVERNANCE_RECOMMENDATIONS_REVIEWED", "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"])
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("actions")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "failed")
      .gte("created_at", lookbackIso)
  ]);

  if (openIncidentsRes.error && !isMissingTable(openIncidentsRes.error.message, "org_incidents")) {
    throw new Error(`open incident lookup failed: ${openIncidentsRes.error.message}`);
  }
  if (plannerRunsRes.error && !isMissingTable(plannerRunsRes.error.message, "planner_runs")) {
    throw new Error(`planner runs lookup failed: ${plannerRunsRes.error.message}`);
  }
  if (reviewEventsRes.error) {
    throw new Error(`review events lookup failed: ${reviewEventsRes.error.message}`);
  }
  if (actionFailedRes.error) {
    throw new Error(`action failures lookup failed: ${actionFailedRes.error.message}`);
  }

  if (openIncidentsRes.data?.id) {
    return {
      evaluated: true,
      opened: false,
      reason: "open_incident_exists"
    };
  }

  const plannerConsecutiveFailed = consecutiveFailuresByStatus(
    ((plannerRunsRes.data ?? []) as Array<{ status: string | null }>).map((row) => ({ status: row.status }))
  );
  const reviewConsecutiveFailed = consecutiveFailuresByEvent(
    ((reviewEventsRes.data ?? []) as Array<{ event_type: string | null }>).map((row) => ({ event_type: row.event_type })),
    "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"
  );
  const actionFailedCount = actionFailedRes.count ?? 0;

  const triggerReasons: string[] = [];
  if (plannerConsecutiveFailed >= failThreshold) {
    triggerReasons.push(`planner consecutive failed=${plannerConsecutiveFailed}`);
  }
  if (reviewConsecutiveFailed >= failThreshold) {
    triggerReasons.push(`review consecutive failed=${reviewConsecutiveFailed}`);
  }
  if (actionFailedCount >= actionFailedThreshold) {
    triggerReasons.push(`action failed burst=${actionFailedCount}/${lookbackHours}h`);
  }

  if (triggerReasons.length === 0) {
    return {
      evaluated: true,
      opened: false,
      reason: "no_trigger",
      metrics: {
        plannerConsecutiveFailed,
        reviewConsecutiveFailed,
        actionFailedCount,
        lookbackHours
      }
    };
  }

  const trigger = triggerReasons.join("; ");
  const reason = `AUTO_SAFETY: ${trigger}`;
  const metadata = {
    source,
    mode: "auto",
    trigger,
    thresholds: {
      failThreshold,
      actionFailedThreshold,
      lookbackHours
    },
    metrics: {
      plannerConsecutiveFailed,
      reviewConsecutiveFailed,
      actionFailedCount
    }
  };

  const { data: inserted, error: incidentInsertError } = await supabase
    .from("org_incidents")
    .insert({
      org_id: orgId,
      status: "open",
      severity: "critical",
      reason,
      opened_by: actorUserId,
      metadata_json: metadata
    })
    .select("id, opened_at")
    .single();

  if (incidentInsertError) {
    if (isMissingTable(incidentInsertError.message, "org_incidents")) {
      return {
        evaluated: false,
        opened: false,
        reason: "incident_table_missing"
      };
    }
    throw new Error(`auto incident insert failed: ${incidentInsertError.message}`);
  }

  const incidentId = inserted.id as string;

  const { error: incidentEventError } = await supabase.from("incident_events").insert({
    org_id: orgId,
    incident_id: incidentId,
    event_type: "INCIDENT_AUTO_DECLARED",
    payload_json: {
      ...metadata,
      opened_at: inserted.opened_at
    }
  });
  if (incidentEventError && !isMissingTable(incidentEventError.message, "incident_events")) {
    throw new Error(`incident event insert failed: ${incidentEventError.message}`);
  }

  const actorId = actorUserId ?? (await resolveFallbackActorUserId({ supabase, orgId }));
  if (actorId) {
    const opsTaskId = await getOrCreateAgentOpsTaskId({
      supabase,
      orgId,
      userId: actorId
    });

    await appendTaskEvent({
      supabase,
      orgId,
      taskId: opsTaskId,
      actorType: "system",
      actorId: null,
      eventType: "INCIDENT_DECLARED",
      payload: {
        incident_id: incidentId,
        severity: "critical",
        reason,
        source: "auto",
        trigger,
        thresholds: metadata.thresholds,
        metrics: metadata.metrics
      }
    });
  }

  return {
    evaluated: true,
    opened: true,
    reason: "triggered",
    incidentId,
    trigger,
    metrics: {
      plannerConsecutiveFailed,
      reviewConsecutiveFailed,
      actionFailedCount,
      lookbackHours
    }
  };
}
