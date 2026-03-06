import {
  clearJobCircuitNow,
  runGovernanceReviewNow,
  runGuardedApprovalReminderJobNow,
  runPlannerNow,
  resendOpsAlertNow,
  runAutoCaseifyNow,
  runAutoIncidentCheckNow,
  runWorkflowTickNow
} from "@/app/app/operations/jobs/actions";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type JobsPageProps = {
  searchParams?: Promise<{
    failed_only?: string;
    window?: string;
    ok?: string;
    error?: string;
    focus?: string;
    ref_job?: string;
    ref_ts?: string;
  }>;
};

type PlannerRunRow = {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  summary_json: unknown;
};

type ReviewEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type AlertEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type IncidentEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type RetryEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type ExternalCaseEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type ManualJobEventRow = {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

type CircuitRow = {
  id: string;
  job_name: string;
  consecutive_failures: number;
  paused_until: string | null;
  resume_stage: "active" | "paused" | "dry_run";
  dry_run_until: string | null;
  last_error: string | null;
  updated_at: string;
};

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isMissingTable(message: string, table: string) {
  return message.includes(`relation "${table}" does not exist`) || message.includes(`public.${table}`);
}

function isMissingColumn(message: string, column: string) {
  return message.includes(`column "${column}" does not exist`) || message.includes(`column ${column} does not exist`);
}

function prettyJson(value: unknown) {
  try {
    return toRedactedJson(value ?? {});
  } catch {
    return "{}";
  }
}

function formatElapsedFromNow(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "たった今";
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function formatDurationMinutes(minutes: number | null) {
  if (minutes === null) return "-";
  if (minutes < 1) return "1分未満";
  if (minutes < 60) return `${Math.round(minutes)}分`;
  const hours = Math.floor(minutes / 60);
  const remain = Math.round(minutes % 60);
  if (remain === 0) return `${hours}時間`;
  return `${hours}時間${remain}分`;
}

function computeMttrMinutes(args: Array<{ created_at: string; isFailure: boolean; isSuccess: boolean }>) {
  const rows = [...args].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  let openFailureAt: number | null = null;
  const recoveries: number[] = [];
  for (const row of rows) {
    const ts = new Date(row.created_at).getTime();
    if (!Number.isFinite(ts)) continue;
    if (row.isFailure) {
      openFailureAt = ts;
      continue;
    }
    if (row.isSuccess && openFailureAt !== null && ts >= openFailureAt) {
      recoveries.push((ts - openFailureAt) / (60 * 1000));
      openFailureAt = null;
    }
  }
  if (recoveries.length === 0) return null;
  const total = recoveries.reduce((sum, value) => sum + value, 0);
  return total / recoveries.length;
}

function parseAutoGuardResultMessage(okMessage: string | undefined, errorMessage: string | undefined) {
  if (errorMessage && errorMessage.includes("guard")) {
    return { kind: "error" as const, message: errorMessage };
  }
  if (!okMessage || !okMessage.includes("guard")) return null;
  if (okMessage.includes("スキップ")) {
    return { kind: "skipped" as const, message: okMessage };
  }
  if (okMessage.includes("guard実行")) {
    return { kind: "success" as const, message: okMessage };
  }
  return { kind: "info" as const, message: okMessage };
}

function consecutiveFailuresByStatus(rows: Array<{ status: string }>) {
  let count = 0;
  for (const row of rows) {
    if (row.status === "failed") {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function consecutiveFailuresByEventType(rows: Array<{ event_type: string }>) {
  let count = 0;
  for (const row of rows) {
    if (row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED") {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function resolveWindowHours(windowValue: string) {
  if (windowValue === "24h") return 24;
  if (windowValue === "30d") return 24 * 30;
  return 24 * 7;
}

function windowLabel(value: "24h" | "7d" | "30d") {
  if (value === "24h") return "24時間";
  if (value === "30d") return "30日";
  return "7日";
}

function focusLabel(focus: string | null) {
  if (focus === "planner") return "Planner";
  if (focus === "review") return "Governance Review";
  if (focus === "caseify") return "Events Auto-Caseify";
  if (focus === "workflow") return "Workflow Tick";
  return null;
}

function sectionCardClass(isFocused: boolean) {
  if (!isFocused) return "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";
  return "rounded-2xl border border-indigo-300 bg-indigo-50/30 p-5 shadow-sm ring-2 ring-indigo-200";
}

function manualJobLabel(jobName: string) {
  if (jobName === "planner_run") return "Planner実行";
  if (jobName === "governance_review") return "Governance Review実行";
  if (jobName === "workflow_tick") return "Workflow Tick実行";
  if (jobName === "events_auto_caseify") return "外部イベントAuto-Caseify実行";
  if (jobName === "ops_alert_resend") return "Opsアラート再送";
  if (jobName === "auto_incident_check") return "自動インシデント判定";
  return jobName;
}

function withQueryParams(path: string, params: Record<string, string | undefined>) {
  const [base, query = ""] = path.split("?");
  const sp = new URLSearchParams(query);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) {
      sp.set(key, value);
    }
  }
  const qs = sp.toString();
  return qs.length > 0 ? `${base}?${qs}` : base;
}

function resolveManualJobHref(args: {
  jobName: string;
  status: "ok" | "error";
  windowFilter: "24h" | "7d" | "30d";
  refTs?: string;
}) {
  const { jobName, status, windowFilter, refTs } = args;
  const addRef = (path: string) =>
    withQueryParams(path, {
      window: windowFilter,
      ref_job: jobName,
      ref_ts: refTs
    });
  if (jobName === "planner_run") {
    return status === "error"
      ? addRef("/app/operations/jobs?failed_only=1&focus=planner")
      : addRef("/app/planner");
  }
  if (jobName === "governance_review") {
    return status === "error"
      ? addRef("/app/operations/jobs?failed_only=1&focus=review")
      : addRef("/app/governance/recommendations");
  }
  if (jobName === "workflow_tick") {
    return status === "error"
      ? addRef("/app/operations/jobs?failed_only=1&focus=workflow")
      : addRef("/app/workflows/runs");
  }
  if (jobName === "events_auto_caseify") {
    return status === "error"
      ? addRef("/app/events?status=new&priority=high")
      : addRef("/app/cases?status=open");
  }
  if (jobName === "ops_alert_resend") {
    return addRef("/app/operations/jobs?failed_only=1");
  }
  if (jobName === "auto_incident_check") {
    return addRef("/app/governance/incidents");
  }
  return addRef("/app/operations/jobs");
}

function plannerStatusLabel(status: string) {
  if (status === "completed") return "成功";
  if (status === "failed") return "失敗";
  if (status === "running") return "実行中";
  return status;
}

function resumeStageLabel(stage: "active" | "paused" | "dry_run") {
  if (stage === "paused") return "停止";
  if (stage === "dry_run") return "ドライラン";
  return "稼働中";
}

export default async function OperationsJobsPage({ searchParams }: JobsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const failedOnly = String(sp.failed_only ?? "") === "1";
  const windowFilter = sp.window === "24h" || sp.window === "30d" ? sp.window : "7d";
  const focus = typeof sp.focus === "string" ? sp.focus : "";
  const refJob = typeof sp.ref_job === "string" ? sp.ref_job : "";
  const refTs = typeof sp.ref_ts === "string" ? sp.ref_ts : "";
  const focusText = focusLabel(focus);
  const isPlannerFocused = focus === "planner";
  const isReviewFocused = focus === "review";
  const isCaseifyFocused = focus === "caseify";
  const isWorkflowFocused = focus === "workflow";
  const collapsePlanner = Boolean(focusText && !isPlannerFocused);
  const collapseReview = Boolean(focusText && !isReviewFocused);
  const collapseCaseify = Boolean(focusText && !isCaseifyFocused);
  const collapseWorkflow = Boolean(focusText && !isWorkflowFocused);
  const windowHours = resolveWindowHours(windowFilter);
  const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const autoGuardResult = parseAutoGuardResultMessage(sp.ok, sp.error);

  const staleHours = Number(process.env.APPROVAL_REMINDER_STALE_HOURS ?? process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6");
  const staleCutoffIso = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
  const autoMinStaleRaw = Number.parseInt(process.env.APPROVAL_REMINDER_AUTO_MIN_STALE ?? "3", 10);
  const autoMinStale = Number.isNaN(autoMinStaleRaw) ? 3 : Math.max(1, Math.min(1000, autoMinStaleRaw));
  const [
    plannerRunsRes,
    reviewEventsRes,
    alertEventsRes,
    incidentEventsRes,
    retryEventsRes,
    pendingApprovalsCountRes,
    autoReminderEventsRes,
    monitorRunsRes,
    externalCaseEventsRes,
    highPriorityExternalEventsCountRes,
    manualJobEventsRes
  ] =
    await Promise.all([
    supabase
      .from("planner_runs")
      .select("id, status, created_at, finished_at, summary_json")
      .eq("org_id", orgId)
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("task_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["GOVERNANCE_RECOMMENDATIONS_REVIEWED", "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("task_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", [
        "OPS_ALERT_POSTED",
        "OPS_ALERT_FAILED",
        "OPS_JOB_CIRCUIT_ALERT_POSTED",
        "OPS_JOB_CIRCUIT_ALERT_FAILED"
      ])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("incident_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["INCIDENT_AUTO_DECLARED"])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("task_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", [
        "OPS_JOB_RETRY_SCHEDULED",
        "OPS_JOB_RETRY_RECOVERED",
        "OPS_JOB_RETRY_EXHAUSTED",
        "OPS_JOB_SKIPPED_CIRCUIT_OPEN",
        "OPS_JOB_CIRCUIT_OPENED",
        "OPS_JOB_CIRCUIT_CLOSED",
        "OPS_JOB_CIRCUIT_MANUALLY_CLEARED",
        "OPS_JOB_DRY_RUN_PASSED",
        "OPS_JOB_DRY_RUN_FAILED"
      ])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending")
      .lt("created_at", staleCutoffIso),
    supabase
      .from("task_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["APPROVAL_REMINDER_AUTO_RUN", "APPROVAL_REMINDER_AUTO_SKIPPED"])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("monitor_runs")
      .select("id, status, created_at, summary_json")
      .eq("org_id", orgId)
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(30)
    ,
    supabase
      .from("case_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "CASE_CREATED_FROM_EXTERNAL_EVENT")
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("external_events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "new")
      .in("priority", ["high", "urgent"]),
    supabase
      .from("task_events")
      .select("id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .eq("event_type", "OPS_JOB_MANUAL_RUN")
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(20)
    ]);

  if (plannerRunsRes.error && !isMissingTable(plannerRunsRes.error.message, "planner_runs")) {
    throw new Error(`Failed to load planner runs: ${plannerRunsRes.error.message}`);
  }
  if (reviewEventsRes.error) {
    throw new Error(`Failed to load governance review events: ${reviewEventsRes.error.message}`);
  }
  if (alertEventsRes.error) {
    throw new Error(`Failed to load ops alert events: ${alertEventsRes.error.message}`);
  }
  if (incidentEventsRes.error && !isMissingTable(incidentEventsRes.error.message, "incident_events")) {
    throw new Error(`Failed to load incident events: ${incidentEventsRes.error.message}`);
  }
  if (retryEventsRes.error) {
    throw new Error(`Failed to load retry events: ${retryEventsRes.error.message}`);
  }
  if (pendingApprovalsCountRes.error) {
    throw new Error(`Failed to load stale pending approvals count: ${pendingApprovalsCountRes.error.message}`);
  }
  if (autoReminderEventsRes.error) {
    throw new Error(`Failed to load auto reminder events: ${autoReminderEventsRes.error.message}`);
  }
  if (monitorRunsRes.error && !isMissingTable(monitorRunsRes.error.message, "monitor_runs")) {
    throw new Error(`Failed to load monitor runs: ${monitorRunsRes.error.message}`);
  }
  if (externalCaseEventsRes.error && !isMissingTable(externalCaseEventsRes.error.message, "case_events")) {
    throw new Error(`Failed to load external caseify events: ${externalCaseEventsRes.error.message}`);
  }
  if (highPriorityExternalEventsCountRes.error && !isMissingTable(highPriorityExternalEventsCountRes.error.message, "external_events")) {
    throw new Error(`Failed to load high priority external events count: ${highPriorityExternalEventsCountRes.error.message}`);
  }
  if (manualJobEventsRes.error) {
    throw new Error(`Failed to load manual job events: ${manualJobEventsRes.error.message}`);
  }
  let circuits: CircuitRow[] = [];
  const circuitPrimary = await supabase
    .from("org_job_circuit_breakers")
    .select("id, job_name, consecutive_failures, paused_until, resume_stage, dry_run_until, last_error, updated_at")
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(30);
  if (!circuitPrimary.error) {
    circuits = ((circuitPrimary.data ?? []) as CircuitRow[]).map((row) => ({
      ...row,
      resume_stage: row.resume_stage ?? "active",
      dry_run_until: row.dry_run_until ?? null,
      last_error: row.last_error ?? null
    }));
  } else if (isMissingTable(circuitPrimary.error.message, "org_job_circuit_breakers")) {
    circuits = [];
  } else if (isMissingColumn(circuitPrimary.error.message, "resume_stage")) {
    const circuitFallback = await supabase
      .from("org_job_circuit_breakers")
      .select("id, job_name, consecutive_failures, paused_until, updated_at")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(30);
    if (!circuitFallback.error) {
      circuits = ((circuitFallback.data ?? []) as Array<{
        id: string;
        job_name: string;
        consecutive_failures: number;
        paused_until: string | null;
        updated_at: string;
      }>).map((row) => ({
        ...row,
        resume_stage: row.paused_until ? "paused" : "active",
        dry_run_until: null,
        last_error: null
      }));
    } else if (!isMissingTable(circuitFallback.error.message, "org_job_circuit_breakers")) {
      throw new Error(`Failed to load job circuit state: ${circuitFallback.error.message}`);
    }
  } else {
    throw new Error(`Failed to load job circuit state: ${circuitPrimary.error.message}`);
  }

  const plannerRuns = (plannerRunsRes.data ?? []) as PlannerRunRow[];
  const reviewEvents = (reviewEventsRes.data ?? []) as ReviewEventRow[];
  const alertEvents = (alertEventsRes.data ?? []) as AlertEventRow[];
  const incidentEvents = (incidentEventsRes.data ?? []) as IncidentEventRow[];
  const retryEvents = (retryEventsRes.data ?? []) as RetryEventRow[];
  const stalePendingApprovals = pendingApprovalsCountRes.count ?? 0;
  const autoReminderEvents = (autoReminderEventsRes.data ?? []) as RetryEventRow[];
  const externalCaseEvents = (externalCaseEventsRes.data ?? []) as ExternalCaseEventRow[];
  const manualJobEvents = (manualJobEventsRes.data ?? []) as ManualJobEventRow[];
  const monitorRuns = (monitorRunsRes.data ?? []) as Array<{
    id: string;
    status: string;
    created_at: string;
    summary_json: unknown;
  }>;
  const highPriorityExternalEvents = highPriorityExternalEventsCountRes.count ?? 0;
  const filteredPlannerRuns = failedOnly ? plannerRuns.filter((row) => row.status === "failed") : plannerRuns;
  const filteredReviewEvents = failedOnly
    ? reviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED")
    : reviewEvents;
  const filteredAlertEvents = failedOnly
    ? alertEvents.filter((row) => row.event_type === "OPS_ALERT_FAILED" || row.event_type === "OPS_JOB_CIRCUIT_ALERT_FAILED")
    : alertEvents;

  const plannerCompleted = plannerRuns.filter((row) => row.status === "completed").length;
  const plannerFailed = plannerRuns.filter((row) => row.status === "failed").length;
  const reviewSuccess = reviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEWED").length;
  const reviewFailed = reviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED").length;
  const alertPosted = alertEvents.filter((row) => row.event_type === "OPS_ALERT_POSTED").length;
  const alertFailed = alertEvents.filter((row) => row.event_type === "OPS_ALERT_FAILED").length;
  const circuitAlertPosted = alertEvents.filter((row) => row.event_type === "OPS_JOB_CIRCUIT_ALERT_POSTED").length;
  const circuitAlertFailed = alertEvents.filter((row) => row.event_type === "OPS_JOB_CIRCUIT_ALERT_FAILED").length;
  const manualResendCount = alertEvents.filter((row) => {
    if (row.event_type !== "OPS_ALERT_POSTED") return false;
    const payload = asObject(row.payload_json);
    return payload?.source === "manual";
  }).length;
  const autoIncidentCount = incidentEvents.length;
  const retryScheduledCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_RETRY_SCHEDULED").length;
  const retryRecoveredCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_RETRY_RECOVERED").length;
  const retryExhaustedCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_RETRY_EXHAUSTED").length;
  const retrySkippedCircuitCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_SKIPPED_CIRCUIT_OPEN").length;
  const dryRunPassedCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_DRY_RUN_PASSED").length;
  const dryRunFailedCount = retryEvents.filter((row) => row.event_type === "OPS_JOB_DRY_RUN_FAILED").length;
  const circuitOpenCount = circuits.filter((row) => {
    if (!row.paused_until) return false;
    const until = new Date(row.paused_until).getTime();
    return Number.isFinite(until) && until > Date.now();
  }).length;
  const latestPlannerFailure = plannerRuns.find((row) => row.status === "failed") ?? null;
  const latestReviewFailure =
    reviewEvents.find((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED") ?? null;
  const latestAlertFailure = alertEvents.find((row) => row.event_type === "OPS_ALERT_FAILED") ?? null;
  const plannerConsecutiveFailures = consecutiveFailuresByStatus(plannerRuns);
  const reviewConsecutiveFailures = consecutiveFailuresByEventType(reviewEvents);
  const autoReminderRunCount = autoReminderEvents.filter((row) => row.event_type === "APPROVAL_REMINDER_AUTO_RUN").length;
  const autoReminderSkippedCount = autoReminderEvents.filter((row) => row.event_type === "APPROVAL_REMINDER_AUTO_SKIPPED").length;
  const autoCaseifyCreatedCount = externalCaseEvents.length;
  const plannerAttempts = plannerCompleted + plannerFailed;
  const plannerSuccessRate = plannerAttempts > 0 ? plannerCompleted / plannerAttempts : 0;
  const plannerMttrMinutes = computeMttrMinutes(
    plannerRuns.map((row) => ({
      created_at: row.created_at,
      isFailure: row.status === "failed",
      isSuccess: row.status === "completed"
    }))
  );
  const reviewAttempts = reviewSuccess + reviewFailed;
  const reviewSuccessRate = reviewAttempts > 0 ? reviewSuccess / reviewAttempts : 0;
  const reviewMttrMinutes = computeMttrMinutes(
    reviewEvents.map((row) => ({
      created_at: row.created_at,
      isFailure: row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED",
      isSuccess: row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEWED"
    }))
  );
  const workflowRecovered = retryEvents.filter((row) => {
    if (row.event_type !== "OPS_JOB_RETRY_RECOVERED") return false;
    const payload = asObject(row.payload_json);
    return payload?.job_name === "workflow_tick_batch" || payload?.job_name === "workflow_tick_single";
  }).length;
  const workflowExhausted = retryEvents.filter((row) => {
    if (row.event_type !== "OPS_JOB_RETRY_EXHAUSTED") return false;
    const payload = asObject(row.payload_json);
    return payload?.job_name === "workflow_tick_batch" || payload?.job_name === "workflow_tick_single";
  }).length;
  const workflowAttempts = workflowRecovered + workflowExhausted;
  const workflowSuccessRate = workflowAttempts > 0 ? workflowRecovered / workflowAttempts : 0;
  const workflowMttrMinutes = computeMttrMinutes(
    retryEvents
      .filter((row) => {
        const payload = asObject(row.payload_json);
        const jobName = typeof payload?.job_name === "string" ? payload.job_name : "";
        return jobName === "workflow_tick_batch" || jobName === "workflow_tick_single";
      })
      .map((row) => ({
        created_at: row.created_at,
        isFailure: row.event_type === "OPS_JOB_RETRY_EXHAUSTED",
        isSuccess: row.event_type === "OPS_JOB_RETRY_RECOVERED"
      }))
  );
  const autoCaseifyRecovered = retryEvents.filter((row) => {
    if (row.event_type !== "OPS_JOB_RETRY_RECOVERED") return false;
    const payload = asObject(row.payload_json);
    return payload?.job_name === "events_auto_caseify_batch";
  }).length;
  const autoCaseifyExhausted = retryEvents.filter((row) => {
    if (row.event_type !== "OPS_JOB_RETRY_EXHAUSTED") return false;
    const payload = asObject(row.payload_json);
    return payload?.job_name === "events_auto_caseify_batch";
  }).length;
  const autoCaseifyAttempts = autoCaseifyRecovered + autoCaseifyExhausted;
  const autoCaseifySuccessRate = autoCaseifyAttempts > 0 ? autoCaseifyRecovered / autoCaseifyAttempts : 0;
  const autoCaseifyMttrMinutes = computeMttrMinutes(
    retryEvents
      .filter((row) => {
        const payload = asObject(row.payload_json);
        return payload?.job_name === "events_auto_caseify_batch";
      })
      .map((row) => ({
        created_at: row.created_at,
        isFailure: row.event_type === "OPS_JOB_RETRY_EXHAUSTED",
        isSuccess: row.event_type === "OPS_JOB_RETRY_RECOVERED"
      }))
  );
  const monitorIncidentSkippedCount = monitorRuns.filter((row) => {
    const summary = asObject(row.summary_json);
    return summary?.blocked_by_incident === true;
  }).length;
  const latestMonitorIncidentSkip =
    monitorRuns.find((row) => {
      const summary = asObject(row.summary_json);
      return summary?.blocked_by_incident === true;
    }) ?? null;
  const latestMonitorIncidentSkipSeverity = (() => {
    const summary = asObject(latestMonitorIncidentSkip?.summary_json ?? null);
    return typeof summary?.incident_severity === "string" ? summary.incident_severity : null;
  })();
  const latestAutoReminderEvent = autoReminderEvents[0] ?? null;
  const latestManualJobEvent = manualJobEvents[0] ?? null;
  const latestAutoReminderPayload = asObject(latestAutoReminderEvent?.payload_json ?? null);
  const latestAutoReminderReason =
    typeof latestAutoReminderPayload?.reason === "string" ? latestAutoReminderPayload.reason : "-";
  const latestAutoReminderSentCount = Number(latestAutoReminderPayload?.sent_count ?? 0);
  const suggestedGuardMinStale =
    stalePendingApprovals >= 10 ? 10 : stalePendingApprovals >= 5 ? 5 : stalePendingApprovals >= 3 ? 3 : 1;

  const barItems = [
    { key: "planner_completed", label: "プランナー 成功", value: plannerCompleted, color: "bg-emerald-500" },
    { key: "planner_failed", label: "プランナー 失敗", value: plannerFailed, color: "bg-rose-500" },
    { key: "review_ok", label: "レビュー 成功", value: reviewSuccess, color: "bg-sky-500" },
    { key: "review_failed", label: "レビュー 失敗", value: reviewFailed, color: "bg-amber-500" }
  ];
  const maxBar = Math.max(1, ...barItems.map((item) => item.value));
  const autoBarItems = [
    { key: "auto_run", label: "自動実行", value: autoReminderRunCount, color: "bg-indigo-500" },
    { key: "auto_skipped", label: "自動スキップ", value: autoReminderSkippedCount, color: "bg-slate-400" }
  ];
  const maxAutoBar = Math.max(1, ...autoBarItems.map((item) => item.value));
  const isAutoRunMissing = stalePendingApprovals >= autoMinStale && autoReminderRunCount === 0;
  const isAutoSkipDominant = autoReminderSkippedCount > autoReminderRunCount;
  const autoGuardGuidance = isAutoRunMissing
    ? "推奨: staleが閾値以上ですが auto_run がないため、手動で Guard再通知を1回実行。"
    : isAutoSkipDominant
      ? "推奨: skipがrunを上回るため、閾値を一時的に下げて実行可否を再評価。"
      : stalePendingApprovals < autoMinStale
        ? "推奨: stale件数は閾値未満。現行設定を維持し、過剰通知を回避。"
        : "推奨: runが機能中。現行閾値で監視を継続。";
  const autoGuardActionThreshold = isAutoSkipDominant ? Math.max(1, suggestedGuardMinStale - 1) : suggestedGuardMinStale;
  const autoGuardActionLabel = isAutoSkipDominant
    ? `推奨実行: 低閾値(${autoGuardActionThreshold})`
    : `推奨実行: 閾値(${autoGuardActionThreshold})`;
  const shouldShowAutoGuardAction = isAutoRunMissing || isAutoSkipDominant;
  const plannerDisplayRuns = isPlannerFocused
    ? [
        ...filteredPlannerRuns.filter((row) => row.status === "failed"),
        ...filteredPlannerRuns.filter((row) => row.status !== "failed")
      ]
    : filteredPlannerRuns;
  const reviewDisplayEvents = isReviewFocused
    ? [
        ...filteredReviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"),
        ...filteredReviewEvents.filter((row) => row.event_type !== "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED")
      ]
    : filteredReviewEvents;
  const workflowSortedEvents = isWorkflowFocused
    ? [
        ...retryEvents.filter(
          (row) =>
            row.event_type === "OPS_JOB_RETRY_EXHAUSTED" ||
            row.event_type === "OPS_JOB_DRY_RUN_FAILED" ||
            row.event_type === "OPS_JOB_SKIPPED_CIRCUIT_OPEN"
        ),
        ...retryEvents.filter(
          (row) =>
            row.event_type !== "OPS_JOB_RETRY_EXHAUSTED" &&
            row.event_type !== "OPS_JOB_DRY_RUN_FAILED" &&
            row.event_type !== "OPS_JOB_SKIPPED_CIRCUIT_OPEN"
        )
      ]
    : retryEvents;
  const workflowDisplayEvents = workflowSortedEvents.slice(0, 12);
  const latestPlannerFailedRow = plannerDisplayRuns.find((row) => row.status === "failed") ?? null;
  const latestReviewFailedRow =
    reviewDisplayEvents.find((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED") ?? null;
  const latestWorkflowFailedRow =
    workflowDisplayEvents.find(
      (row) =>
        row.event_type === "OPS_JOB_RETRY_EXHAUSTED" ||
        row.event_type === "OPS_JOB_DRY_RUN_FAILED" ||
        row.event_type === "OPS_JOB_SKIPPED_CIRCUIT_OPEN"
    ) ?? null;
  const hasActiveFilters = failedOnly || windowFilter !== "7d" || Boolean(focusText);
  const filterSummary = [
    failedOnly ? "失敗のみ表示" : null,
    windowFilter !== "7d" ? `集計期間=${windowLabel(windowFilter)}` : null,
    focusText ? `フォーカス=${focusText}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const currentFilterParams = new URLSearchParams();
  currentFilterParams.set("window", windowFilter);
  if (failedOnly) currentFilterParams.set("failed_only", "1");
  if (focus) currentFilterParams.set("focus", focus);
  const currentFilterPath = `/app/operations/jobs?${currentFilterParams.toString()}`;

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-cyan-900 p-6 text-white shadow-lg">
        <p className="text-xs uppercase tracking-[0.18em] text-cyan-200">運用モニター</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">運用ジョブ履歴</h1>
        <p className="mt-2 text-sm text-slate-200">
          定期実行ジョブ（プランナー / ガバナンス提案レビュー）の状態を確認できます。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={runAutoIncidentCheckNow}>
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <ConfirmSubmitButton
              label="自動インシデント判定"
              pendingLabel="実行中..."
              confirmMessage="自動インシデント判定を即時実行します。よろしいですか？"
              className="rounded-md border border-white/30 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
            />
          </form>
          <form action={runAutoCaseifyNow}>
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <ConfirmSubmitButton
              label="外部イベント自動Case化"
              pendingLabel="実行中..."
              confirmMessage="高優先度の外部イベントを自動Case化します。よろしいですか？"
              className="rounded-md border border-white/30 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
            />
          </form>
          <form action={runWorkflowTickNow}>
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <ConfirmSubmitButton
              label="ワークフローチック実行"
              pendingLabel="実行中..."
              confirmMessage="ワークフローチックを即時実行します。よろしいですか？"
              className="rounded-md border border-white/30 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
            />
          </form>
          <form action={resendOpsAlertNow}>
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <ConfirmSubmitButton
              label="Opsアラートを手動再送"
              pendingLabel="再送中..."
              confirmMessage="Opsアラートを手動再送します。よろしいですか？"
              className="rounded-md border border-white/30 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
            />
          </form>
          <form action={runGuardedApprovalReminderJobNow} className="flex items-center gap-2">
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <input type="hidden" name="min_stale" value={String(suggestedGuardMinStale)} />
            <ConfirmSubmitButton
              label={`承認Guard再通知（${suggestedGuardMinStale}）`}
              pendingLabel="実行中..."
              confirmMessage={`承認Guard再通知を閾値 ${suggestedGuardMinStale} で実行します。よろしいですか？`}
              className="rounded-md border border-white/30 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
            />
          </form>
        </div>
      </div>

      <StatusNotice ok={sp.ok} error={sp.error} />
      {refJob ? (
        <section className="rounded-xl border border-indigo-300 bg-indigo-50 p-3 shadow-sm">
          <p className="text-xs text-indigo-800">
            参照元: {manualJobLabel(refJob)}
            {refTs ? ` / ${new Date(refTs).toLocaleString("ja-JP")}` : ""}
          </p>
        </section>
      ) : null}
      {latestManualJobEvent ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          {(() => {
            const payload = asObject(latestManualJobEvent.payload_json);
            const jobName = typeof payload?.job_name === "string" ? payload.job_name : "unknown";
            const status = payload?.status === "error" ? "error" : "ok";
            const message = typeof payload?.message === "string" ? payload.message : "-";
            const targetHref = resolveManualJobHref({ jobName, status, windowFilter, refTs: latestManualJobEvent.created_at });
            const statusClass =
              status === "error"
                ? "border-rose-300 bg-rose-50 text-rose-900"
                : "border-emerald-300 bg-emerald-50 text-emerald-900";
            return (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">最後に押したアクション</p>
                    <p className="mt-1 text-xs text-slate-600">{new Date(latestManualJobEvent.created_at).toLocaleString("ja-JP")}</p>
                  </div>
                  <span className={`rounded-full border px-2 py-1 text-xs font-medium ${statusClass}`}>
                    {status === "error" ? "失敗" : "成功"}
                  </span>
                </div>
                <p className="mt-2 text-sm font-medium text-slate-800">{manualJobLabel(jobName)}</p>
                <p className="mt-1 text-xs text-slate-700">{message}</p>
                <a
                  href={targetHref}
                  className="mt-2 inline-flex rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  {status === "error" ? "復旧先を開く" : "関連ページを開く"}
                </a>
              </>
            );
          })()}
          <details className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2">
            <summary className="cursor-pointer text-xs font-medium text-slate-700">直近の手動実行履歴（最大20件）</summary>
            <ul className="mt-2 space-y-2">
              {manualJobEvents.slice(0, 5).map((row) => {
                const payload = asObject(row.payload_json);
                const jobName = typeof payload?.job_name === "string" ? payload.job_name : "unknown";
                const statusKind = payload?.status === "error" ? "error" : "ok";
                const status = statusKind === "error" ? "失敗" : "成功";
                const message = typeof payload?.message === "string" ? payload.message : "-";
                const targetHref = resolveManualJobHref({ jobName, status: statusKind, windowFilter, refTs: row.created_at });
                return (
                  <li key={row.id} className="rounded-md border border-slate-200 bg-white p-2 text-xs">
                    <p className="font-medium text-slate-800">
                      {manualJobLabel(jobName)} / {status}
                    </p>
                    <p className="text-slate-600">{new Date(row.created_at).toLocaleString("ja-JP")}</p>
                    <p className="mt-1 text-slate-700">{message}</p>
                    <a href={targetHref} className="mt-1 inline-flex text-[11px] font-medium text-indigo-700 underline">
                      {statusKind === "error" ? "復旧先へ" : "関連ページへ"}
                    </a>
                  </li>
                );
              })}
            </ul>
          </details>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1">集計期間: {windowLabel(windowFilter)}</span>
        {focusText ? <span className="rounded-full border border-indigo-300 bg-indigo-50 px-2 py-1 text-indigo-700">フォーカス: {focusText}</span> : null}
        <span>集計対象は直近 {windowLabel(windowFilter)}（最大30件）です。</span>
        <CopyFilterLinkButton path={currentFilterPath} />
        {hasActiveFilters ? (
          <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">条件付き表示</span>
        ) : null}
      </div>
      {hasActiveFilters ? <p className="-mt-4 text-xs text-slate-600">{filterSummary}</p> : null}
      {focusText ? (
        <section className="rounded-xl border border-indigo-300 bg-indigo-50 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-indigo-900">フォーカス中: {focusText}</p>
              <p className="mt-1 text-xs text-indigo-800">該当セクションを強調表示しています。下の「詳細へ」で直接移動できます。</p>
            </div>
            <a
              href={
                isPlannerFocused
                  ? "#section-planner"
                  : isReviewFocused
                    ? "#section-review"
                    : isCaseifyFocused
                      ? "#section-caseify"
                      : "#section-workflow"
              }
              className="rounded-md border border-indigo-300 bg-white px-3 py-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
            >
              詳細へ移動
            </a>
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-8">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <p className="text-xs text-emerald-700">プランナー 成功</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{plannerCompleted}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">プランナー 失敗</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{plannerFailed}</p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-xs text-sky-700">レビュー 成功</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{reviewSuccess}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <p className="text-xs text-amber-700">レビュー 失敗</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{reviewFailed}</p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-xs text-sky-700">Opsアラート送信</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{alertPosted}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">Opsアラート失敗</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{alertFailed}</p>
        </div>
        <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 shadow-sm">
          <p className="text-xs text-cyan-700">サーキット通知送信</p>
          <p className="mt-1 text-2xl font-semibold text-cyan-900">{circuitAlertPosted}</p>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm">
          <p className="text-xs text-red-700">サーキット通知失敗</p>
          <p className="mt-1 text-2xl font-semibold text-red-900">{circuitAlertFailed}</p>
        </div>
        <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 shadow-sm">
          <p className="text-xs text-violet-700">手動再送（最大30）</p>
          <p className="mt-1 text-2xl font-semibold text-violet-900">{manualResendCount}</p>
        </div>
        <div className="rounded-xl border border-fuchsia-200 bg-fuchsia-50 p-4 shadow-sm">
          <p className="text-xs text-fuchsia-700">自動インシデント（最大30）</p>
          <p className="mt-1 text-2xl font-semibold text-fuchsia-900">{autoIncidentCount}</p>
        </div>
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-4 shadow-sm">
          <p className="text-xs text-teal-700">外部イベントCase化（最大30）</p>
          <p className="mt-1 text-2xl font-semibold text-teal-900">{autoCaseifyCreatedCount}</p>
        </div>
        <div
          className={`rounded-xl border p-4 shadow-sm ${
            highPriorityExternalEvents > 0 ? "border-rose-300 bg-rose-50" : "border-cyan-200 bg-cyan-50"
          }`}
        >
          <p className={`text-xs ${highPriorityExternalEvents > 0 ? "text-rose-700" : "text-cyan-700"}`}>高優先度未処理外部イベント</p>
          <p className={`mt-1 text-2xl font-semibold ${highPriorityExternalEvents > 0 ? "text-rose-900" : "text-cyan-900"}`}>
            {highPriorityExternalEvents}
          </p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
          <p className="text-xs text-indigo-700">リトライ予約</p>
          <p className="mt-1 text-2xl font-semibold text-indigo-900">{retryScheduledCount}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <p className="text-xs text-emerald-700">リトライ回復</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{retryRecoveredCount}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">リトライ上限到達</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{retryExhaustedCount}</p>
        </div>
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 shadow-sm">
          <p className="text-xs text-orange-700">サーキット開放中</p>
          <p className="mt-1 text-2xl font-semibold text-orange-900">{circuitOpenCount}</p>
        </div>
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4 shadow-sm">
          <p className="text-xs text-yellow-700">サーキットでスキップ</p>
          <p className="mt-1 text-2xl font-semibold text-yellow-900">{retrySkippedCircuitCount}</p>
        </div>
        <div className={`rounded-xl border p-4 shadow-sm ${stalePendingApprovals >= autoMinStale ? "border-rose-300 bg-rose-50" : "border-indigo-200 bg-indigo-50"}`}>
          <p className={`text-xs ${stalePendingApprovals >= autoMinStale ? "text-rose-700" : "text-indigo-700"}`}>
            長期滞留承認（{staleHours}時間超）
          </p>
          <p className={`mt-1 text-2xl font-semibold ${stalePendingApprovals >= autoMinStale ? "text-rose-900" : "text-indigo-900"}`}>
            {stalePendingApprovals}
          </p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
          <p className="text-xs text-indigo-700">承認Auto実行/スキップ</p>
          <p className="mt-1 text-2xl font-semibold text-indigo-900">
            {autoReminderRunCount}/{autoReminderSkippedCount}
          </p>
          <p className="mt-1 text-[11px] text-indigo-700">
            最新: {latestAutoReminderReason} / 送信数={latestAutoReminderSentCount}
          </p>
        </div>
        <div className="rounded-xl border border-lime-200 bg-lime-50 p-4 shadow-sm">
          <p className="text-xs text-lime-700">ドライラン成功</p>
          <p className="mt-1 text-2xl font-semibold text-lime-900">{dryRunPassedCount}</p>
        </div>
        <div className="rounded-xl border border-orange-300 bg-orange-50 p-4 shadow-sm">
          <p className="text-xs text-orange-700">ドライラン失敗</p>
          <p className="mt-1 text-2xl font-semibold text-orange-900">{dryRunFailedCount}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">監視停止（インシデント）</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{monitorIncidentSkippedCount}</p>
          <p className="mt-1 text-[11px] text-rose-700">
              {latestMonitorIncidentSkip
              ? `最新: ${formatElapsedFromNow(latestMonitorIncidentSkip.created_at)}${latestMonitorIncidentSkipSeverity ? ` / 重大度=${latestMonitorIncidentSkipSeverity}` : ""}`
              : "最新: -"}
          </p>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">失敗ヘルス指標</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs text-rose-700">プランナー: 直近失敗からの経過</p>
            <p className="mt-1 text-lg font-semibold text-rose-900">
              {latestPlannerFailure ? formatElapsedFromNow(latestPlannerFailure.created_at) : "失敗なし"}
            </p>
            <p className="mt-1 text-xs text-rose-700">連続失敗: {plannerConsecutiveFailures}</p>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs text-amber-700">レビュー: 直近失敗からの経過</p>
            <p className="mt-1 text-lg font-semibold text-amber-900">
              {latestReviewFailure ? formatElapsedFromNow(latestReviewFailure.created_at) : "失敗なし"}
            </p>
            <p className="mt-1 text-xs text-amber-700">連続失敗: {reviewConsecutiveFailures}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          Opsアラート最終失敗: {latestAlertFailure ? formatElapsedFromNow(latestAlertFailure.created_at) : "失敗なし"}
        </p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">ジョブSLO（{windowLabel(windowFilter)}）</h2>
          <span className="text-xs text-slate-500">成功率 / MTTR（失敗から次の成功まで）</span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs text-emerald-700">Planner</p>
            <p className="mt-1 text-lg font-semibold text-emerald-900">{formatPercent(plannerSuccessRate)}</p>
            <p className="text-xs text-emerald-800">MTTR: {formatDurationMinutes(plannerMttrMinutes)}</p>
          </div>
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
            <p className="text-xs text-sky-700">Governance Review</p>
            <p className="mt-1 text-lg font-semibold text-sky-900">{formatPercent(reviewSuccessRate)}</p>
            <p className="text-xs text-sky-800">MTTR: {formatDurationMinutes(reviewMttrMinutes)}</p>
          </div>
          <div className="rounded-lg border border-teal-200 bg-teal-50 p-3">
            <p className="text-xs text-teal-700">Events Auto-Caseify</p>
            <p className="mt-1 text-lg font-semibold text-teal-900">{formatPercent(autoCaseifySuccessRate)}</p>
            <p className="text-xs text-teal-800">MTTR: {formatDurationMinutes(autoCaseifyMttrMinutes)}</p>
          </div>
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
            <p className="text-xs text-indigo-700">Workflow Tick</p>
            <p className="mt-1 text-lg font-semibold text-indigo-900">{formatPercent(workflowSuccessRate)}</p>
            <p className="text-xs text-indigo-800">MTTR: {formatDurationMinutes(workflowMttrMinutes)}</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">承認自動ガード推移（{windowLabel(windowFilter)}）</h2>
          <span className="text-xs text-slate-500">0件は棒を表示しません</span>
        </div>
        {autoGuardResult ? (
          <div
            className={`mt-3 rounded-md border px-3 py-2 text-xs ${
              autoGuardResult.kind === "success"
                ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                : autoGuardResult.kind === "skipped"
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : autoGuardResult.kind === "error"
                    ? "border-rose-300 bg-rose-50 text-rose-900"
                    : "border-slate-300 bg-slate-50 text-slate-800"
            }`}
          >
            自動ガード結果: {autoGuardResult.message}
          </div>
        ) : null}
        <div className="mt-2 text-xs text-slate-600">
          長期滞留承認: {stalePendingApprovals} / 閾値: {autoMinStale} / 最新理由: {latestAutoReminderReason}
        </div>
        <p className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">{autoGuardGuidance}</p>
        {shouldShowAutoGuardAction ? (
          <form action={runGuardedApprovalReminderJobNow} className="mt-2">
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <input type="hidden" name="min_stale" value={String(autoGuardActionThreshold)} />
            <ConfirmSubmitButton
              label={autoGuardActionLabel}
              pendingLabel="実行中..."
              confirmMessage={`承認Guard再通知を閾値 ${autoGuardActionThreshold} で実行します。よろしいですか？`}
              className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
            />
          </form>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-2">
          {autoBarItems.map((item) => {
            const heightPct = item.value > 0 ? Math.max(12, Math.round((item.value / maxAutoBar) * 100)) : 0;
            return (
              <div key={item.key} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="flex h-32 items-end justify-center rounded-md bg-white px-2">
                  {item.value > 0 ? <div className={`w-10 rounded-t-md ${item.color}`} style={{ height: `${heightPct}%` }} /> : null}
                </div>
                <p className="mt-2 text-center text-[11px] text-slate-600">{item.label}</p>
                <p className="text-center text-sm font-semibold text-slate-900">{item.value}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">ジョブ結果分布</h2>
          <span className="text-xs text-slate-500">0件は棒を表示しません</span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {barItems.map((item) => {
            const heightPct = item.value > 0 ? Math.max(12, Math.round((item.value / maxBar) * 100)) : 0;
            return (
              <div key={item.key} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="flex h-36 items-end justify-center rounded-md bg-white px-2">
                  {item.value > 0 ? <div className={`w-10 rounded-t-md ${item.color}`} style={{ height: `${heightPct}%` }} /> : null}
                </div>
                <p className="mt-2 text-center text-[11px] text-slate-600">{item.label}</p>
                <p className="text-center text-sm font-semibold text-slate-900">{item.value}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section id="section-planner" className={sectionCardClass(isPlannerFocused)}>
        <details open={!collapsePlanner}>
          {collapsePlanner ? (
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">プランナー実行履歴（折りたたみ）</summary>
          ) : null}
          <div className={collapsePlanner ? "mt-3" : ""}>
            <form method="get" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" name="failed_only" value="1" defaultChecked={failedOnly} className="h-4 w-4 rounded border-slate-300" />
                  失敗のみ表示
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  集計期間
                  <select name="window" defaultValue={windowFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs">
                    <option value="24h">24時間</option>
                    <option value="7d">7日</option>
                    <option value="30d">30日</option>
                  </select>
                </label>
              </div>
              <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
                適用
              </button>
            </form>
            <h2 className="text-base font-semibold text-slate-900">プランナー実行履歴（{windowLabel(windowFilter)} / 最新30件）</h2>
            {isPlannerFocused ? (
              <div className="mt-2">
                <form action={runPlannerNow}>
                  <input type="hidden" name="return_to" value={currentFilterPath} />
                  <ConfirmSubmitButton
                    label="Plannerを即時実行"
                    pendingLabel="実行中..."
                    confirmMessage="Plannerをこの場で実行します。よろしいですか？"
                    className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                  />
                </form>
              </div>
            ) : null}
            {isPlannerFocused && latestPlannerFailedRow ? (
              <p className="mt-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                最新失敗: {new Date(latestPlannerFailedRow.created_at).toLocaleString("ja-JP")} / status=failed
              </p>
            ) : null}
            {plannerDisplayRuns.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {plannerDisplayRuns.map((run) => (
                  (() => {
                    const isRef = Boolean(refTs && run.created_at === refTs);
                    return (
                  <li
                    key={run.id}
                    className={`rounded-md border p-3 text-sm ${
                      isRef
                        ? "border-indigo-300 bg-indigo-50"
                        : run.status === "failed"
                          ? "border-rose-200 bg-rose-50/60"
                          : "border-slate-200"
                    }`}
                  >
                    <p className="mt-1 text-slate-800">
                      ステータス:{" "}
                      <span className={run.status === "failed" ? "font-semibold text-rose-700" : "font-semibold text-emerald-700"}>
                        {plannerStatusLabel(run.status)}
                      </span>
                    </p>
                    <p className="text-xs text-slate-600">
                      開始: {new Date(run.created_at).toLocaleString("ja-JP")}
                      {run.finished_at ? ` / 終了: ${new Date(run.finished_at).toLocaleString("ja-JP")}` : ""}
                    </p>
                    {run.status === "failed" ? (
                      <details className="mt-2 rounded-md border border-rose-200 bg-rose-50 p-2">
                        <summary className="cursor-pointer text-xs font-medium text-rose-700">失敗詳細（JSON）</summary>
                        <pre className="mt-2 overflow-x-auto text-xs text-rose-800">{prettyJson(run.summary_json)}</pre>
                      </details>
                    ) : null}
                  </li>
                    );
                  })()
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                {failedOnly ? "失敗したプランナー実行はありません。" : "プランナー実行履歴はまだありません。"}
              </p>
            )}
          </div>
        </details>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">ジョブサーキット状態</h2>
          <form action={clearJobCircuitNow} className="flex items-center gap-2">
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <input
              type="text"
              name="reason"
              placeholder="解除理由（監査用）"
              required
              className="w-48 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700"
            />
            <button
              type="submit"
              className="rounded-md border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
            >
              全サーキット解除
            </button>
          </form>
        </div>
        {circuits.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">サーキット状態はまだありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2">ジョブ名</th>
                  <th className="px-2 py-2">連続失敗</th>
                  <th className="px-2 py-2">状態</th>
                  <th className="px-2 py-2">停止期限</th>
                  <th className="px-2 py-2">ドライラン期限</th>
                  <th className="px-2 py-2">最終エラー</th>
                  <th className="px-2 py-2">更新日時</th>
                  <th className="px-2 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {circuits.map((row) => {
                  const isOpen =
                    row.paused_until && Number.isFinite(new Date(row.paused_until).getTime())
                      ? new Date(row.paused_until).getTime() > Date.now()
                      : false;
                  return (
                    <tr key={row.id} className="border-b border-slate-100 text-slate-700">
                      <td className="px-2 py-2 font-mono text-xs">{row.job_name}</td>
                      <td className="px-2 py-2">{row.consecutive_failures}</td>
                      <td className="px-2 py-2">
                        <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-xs">
                          {resumeStageLabel(row.resume_stage)}
                        </span>
                      </td>
                      <td className={`px-2 py-2 ${isOpen ? "font-semibold text-orange-700" : "text-slate-500"}`}>
                        {row.paused_until ? new Date(row.paused_until).toLocaleString("ja-JP") : "-"}
                      </td>
                      <td className="px-2 py-2 text-slate-500">
                        {row.dry_run_until ? new Date(row.dry_run_until).toLocaleString("ja-JP") : "-"}
                      </td>
                      <td className="max-w-[240px] truncate px-2 py-2 text-xs text-slate-500">
                        {row.last_error || "-"}
                      </td>
                      <td className="px-2 py-2 text-slate-500">{new Date(row.updated_at).toLocaleString("ja-JP")}</td>
                      <td className="px-2 py-2 text-right">
                        <form action={clearJobCircuitNow} className="flex items-center justify-end gap-2">
                          <input type="hidden" name="return_to" value={currentFilterPath} />
                          <input type="hidden" name="job_name" value={row.job_name} />
                          <input
                            type="text"
                            name="reason"
                            placeholder="理由"
                            required
                            className="w-28 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                          />
                          <button
                            type="submit"
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                          >
                            このジョブを解除
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section id="section-workflow" className={sectionCardClass(isWorkflowFocused)}>
        <details open={!collapseWorkflow}>
          {collapseWorkflow ? (
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">自動リトライ監査イベント（折りたたみ）</summary>
          ) : null}
          <div className={collapseWorkflow ? "mt-3" : ""}>
            <h2 className="text-sm font-semibold text-slate-900">自動リトライ監査イベント</h2>
            {isWorkflowFocused ? (
              <div className="mt-2">
                <form action={runWorkflowTickNow}>
                  <input type="hidden" name="return_to" value={currentFilterPath} />
                  <ConfirmSubmitButton
                    label="Workflow Tickを即時実行"
                    pendingLabel="実行中..."
                    confirmMessage="Workflow Tickをこの場で実行します。よろしいですか？"
                    className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                  />
                </form>
              </div>
            ) : null}
            {isWorkflowFocused && latestWorkflowFailedRow ? (
              <p className="mt-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                最新失敗: {new Date(latestWorkflowFailedRow.created_at).toLocaleString("ja-JP")} / {latestWorkflowFailedRow.event_type}
              </p>
            ) : null}
            {workflowDisplayEvents.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">リトライイベントはまだありません。</p>
            ) : (
              <div className="mt-3 space-y-3">
                {workflowDisplayEvents.map((row) => (
                  (() => {
                    const isRef = Boolean(refTs && row.created_at === refTs);
                    return (
                  <article
                    key={row.id}
                    className={`rounded-lg border p-3 ${
                      isRef
                        ? "border-indigo-300 bg-indigo-50"
                        : row.event_type === "OPS_JOB_RETRY_EXHAUSTED" ||
                            row.event_type === "OPS_JOB_DRY_RUN_FAILED" ||
                            row.event_type === "OPS_JOB_SKIPPED_CIRCUIT_OPEN"
                          ? "border-rose-200 bg-rose-50/70"
                          : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold text-slate-800">{row.event_type}</p>
                      <time className="text-xs text-slate-500">{new Date(row.created_at).toLocaleString("ja-JP")}</time>
                    </div>
                    {row.event_type === "OPS_JOB_CIRCUIT_MANUALLY_CLEARED" ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          手動解除
                        </span>
                        <span className="text-xs text-slate-700">
                          理由:{" "}
                          <span className="font-medium">
                            {(() => {
                              const payload = asObject(row.payload_json);
                              return typeof payload?.reason === "string" && payload.reason.trim()
                                ? payload.reason
                                : "手動解除";
                            })()}
                          </span>
                        </span>
                      </div>
                    ) : null}
                    <pre className="mt-2 overflow-x-auto rounded-md bg-white p-2 text-xs text-slate-700">
                      {prettyJson(row.payload_json)}
                    </pre>
                  </article>
                    );
                  })()
                ))}
              </div>
            )}
          </div>
        </details>
      </section>

      <section id="section-review" className={sectionCardClass(isReviewFocused)}>
        <details open={!collapseReview}>
          {collapseReview ? (
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">ガバナンスレビュー履歴（折りたたみ）</summary>
          ) : null}
          <div className={collapseReview ? "mt-3" : ""}>
            <h2 className="text-base font-semibold text-slate-900">ガバナンスレビュー履歴（{windowLabel(windowFilter)} / 最新30件）</h2>
            {isReviewFocused ? (
              <div className="mt-2">
                <form action={runGovernanceReviewNow}>
                  <input type="hidden" name="return_to" value={currentFilterPath} />
                  <ConfirmSubmitButton
                    label="レビューを即時実行"
                    pendingLabel="実行中..."
                    confirmMessage="ガバナンスレビューをこの場で実行します。よろしいですか？"
                    className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                  />
                </form>
              </div>
            ) : null}
            {isReviewFocused && latestReviewFailedRow ? (
              <p className="mt-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                最新失敗: {new Date(latestReviewFailedRow.created_at).toLocaleString("ja-JP")} / {latestReviewFailedRow.event_type}
              </p>
            ) : null}
            {reviewDisplayEvents.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {reviewDisplayEvents.map((event) => {
                  const payload = asObject(event.payload_json);
                  const error = typeof payload?.error === "string" ? payload.error : null;
                  const recommendationCount =
                    typeof payload?.recommendation_count === "number" ? payload.recommendation_count : null;
                  const isRef = Boolean(refTs && event.created_at === refTs);
                  return (
                    <li
                      key={event.id}
                      className={`rounded-md border p-3 text-sm ${
                        isRef
                          ? "border-indigo-300 bg-indigo-50"
                          : event.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"
                            ? "border-rose-200 bg-rose-50/60"
                            : "border-slate-200"
                      }`}
                    >
                      <p className="mt-1">
                        種別:{" "}
                        <span
                          className={
                            event.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"
                              ? "font-semibold text-rose-700"
                              : "font-semibold text-sky-700"
                          }
                        >
                          {event.event_type}
                        </span>
                      </p>
                      <p className="text-xs text-slate-600">時刻: {new Date(event.created_at).toLocaleString("ja-JP")}</p>
                      {recommendationCount !== null ? <p className="text-xs text-slate-600">提案件数: {recommendationCount}</p> : null}
                      {error ? <p className="mt-1 text-xs text-rose-700">エラー: {error}</p> : null}
                      <details className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                        <summary className="cursor-pointer text-xs font-medium text-slate-700">ペイロードJSON</summary>
                        <pre className="mt-2 overflow-x-auto text-xs text-slate-700">{prettyJson(event.payload_json)}</pre>
                      </details>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                {failedOnly ? "失敗したガバナンスレビューはありません。" : "ガバナンスレビュー履歴はまだありません。"}
              </p>
            )}
          </div>
        </details>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Opsアラート履歴（{windowLabel(windowFilter)} / 最新30件）</h2>
        {filteredAlertEvents.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {filteredAlertEvents.map((event) => {
              const payload = asObject(event.payload_json);
              const error = typeof payload?.error === "string" ? payload.error : null;
              const threshold = typeof payload?.threshold === "number" ? payload.threshold : null;
              const alertKey =
                typeof payload?.alert_key === "string" && payload.alert_key.length > 0
                  ? payload.alert_key
                  : null;
              const health = asObject(payload?.health);
              const slackPermalink =
                typeof payload?.slack_permalink === "string" && payload.slack_permalink.length > 0
                  ? payload.slack_permalink
                  : null;
              const channelId =
                typeof payload?.channel_id === "string" && payload.channel_id.length > 0
                  ? payload.channel_id
                  : null;
              return (
                <li key={event.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="mt-1">
                    種別:{" "}
                    <span
                      className={
                        event.event_type === "OPS_ALERT_FAILED"
                          ? "font-semibold text-rose-700"
                          : "font-semibold text-sky-700"
                      }
                    >
                      {event.event_type}
                    </span>
                  </p>
                  <p className="text-xs text-slate-600">時刻: {new Date(event.created_at).toLocaleString("ja-JP")}</p>
                  {threshold !== null ? <p className="text-xs text-slate-600">閾値: {threshold}</p> : null}
                  {alertKey ? <p className="text-xs text-slate-600">アラートキー: <span className="font-mono">{alertKey}</span></p> : null}
                  {health ? (
                    <p className="text-xs text-slate-600">
                      プランナー失敗連続={String(health.plannerConsecutiveFailures ?? "-")} / レビュー失敗連続=
                      {String(health.reviewConsecutiveFailures ?? "-")}
                    </p>
                  ) : null}
                  {slackPermalink ? (
                    <a
                      href={slackPermalink}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex text-xs font-medium text-sky-700 underline"
                    >
                      Slackメッセージを開く
                    </a>
                  ) : channelId ? (
                    <a
                      href={`https://slack.com/app_redirect?channel=${encodeURIComponent(channelId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex text-xs font-medium text-sky-700 underline"
                    >
                      Slackチャンネルを開く
                    </a>
                  ) : null}
                  {error ? <p className="mt-1 text-xs text-rose-700">エラー: {error}</p> : null}
                  <details className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                    <summary className="cursor-pointer text-xs font-medium text-slate-700">ペイロードJSON</summary>
                    <pre className="mt-2 overflow-x-auto text-xs text-slate-700">{prettyJson(event.payload_json)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            {failedOnly ? "失敗したOpsアラートはありません。" : "Opsアラート履歴はまだありません。"}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">自動インシデント履歴（{windowLabel(windowFilter)} / 最新30件）</h2>
        {incidentEvents.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {incidentEvents.map((event) => {
              const payload = asObject(event.payload_json);
              const trigger = typeof payload?.trigger === "string" ? payload.trigger : null;
              const metrics = asObject(payload?.metrics);
              return (
                <li key={event.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="mt-1">
                    種別: <span className="font-semibold text-fuchsia-700">{event.event_type}</span>
                  </p>
                  <p className="text-xs text-slate-600">時刻: {new Date(event.created_at).toLocaleString("ja-JP")}</p>
                  {trigger ? <p className="text-xs text-slate-700">トリガー: {trigger}</p> : null}
                  {metrics ? (
                    <p className="text-xs text-slate-600">
                      プランナー={String(metrics.plannerConsecutiveFailed ?? "-")} / レビュー=
                      {String(metrics.reviewConsecutiveFailed ?? "-")} / アクション失敗=
                      {String(metrics.actionFailedCount ?? "-")}
                    </p>
                  ) : null}
                  <details className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                    <summary className="cursor-pointer text-xs font-medium text-slate-700">ペイロードJSON</summary>
                    <pre className="mt-2 overflow-x-auto text-xs text-slate-700">{prettyJson(event.payload_json)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">自動インシデント履歴はまだありません。</p>
        )}
      </section>

      <section id="section-caseify" className={sectionCardClass(isCaseifyFocused)}>
        <details open={!collapseCaseify}>
          {collapseCaseify ? (
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">外部イベント自動Case化履歴（折りたたみ）</summary>
          ) : null}
          <div className={collapseCaseify ? "mt-3" : ""}>
            <h2 className="text-base font-semibold text-slate-900">外部イベント自動Case化履歴（{windowLabel(windowFilter)} / 最新30件）</h2>
            {isCaseifyFocused ? (
              <div className="mt-2">
                <form action={runAutoCaseifyNow}>
                  <input type="hidden" name="return_to" value={currentFilterPath} />
                  <ConfirmSubmitButton
                    label="外部イベント自動Case化を実行"
                    pendingLabel="実行中..."
                    confirmMessage="高優先度外部イベントを自動Case化します。よろしいですか？"
                    className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                  />
                </form>
              </div>
            ) : null}
            {externalCaseEvents.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {externalCaseEvents.map((event) => {
                  const payload = asObject(event.payload_json);
                  const provider = typeof payload?.provider === "string" ? payload.provider : "-";
                  const sourceEventType = typeof payload?.event_type === "string" ? payload.event_type : "-";
                  const summary = typeof payload?.summary === "string" ? payload.summary : null;
                  return (
                    <li key={event.id} className="rounded-md border border-slate-200 p-3 text-sm">
                      <p className="mt-1">
                        種別: <span className="font-semibold text-teal-700">{event.event_type}</span>
                      </p>
                      <p className="text-xs text-slate-600">時刻: {new Date(event.created_at).toLocaleString("ja-JP")}</p>
                      <p className="text-xs text-slate-600">
                        provider={provider} / source_event_type={sourceEventType}
                      </p>
                      {summary ? <p className="mt-1 text-xs text-slate-700">概要: {summary}</p> : null}
                      <details className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                        <summary className="cursor-pointer text-xs font-medium text-slate-700">ペイロードJSON</summary>
                        <pre className="mt-2 overflow-x-auto text-xs text-slate-700">{prettyJson(event.payload_json)}</pre>
                      </details>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-600">外部イベント自動Case化履歴はまだありません。</p>
            )}
          </div>
        </details>
      </section>
    </section>
  );
}
