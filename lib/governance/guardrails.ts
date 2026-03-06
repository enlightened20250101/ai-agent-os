import type { SupabaseClient } from "@supabase/supabase-js";

export type ApprovalGuardrailContext = {
  distinctApproverCount: number;
  requiredApprovals: number;
  highRiskThreshold: number;
  isHighRisk: boolean;
};

export type HourlyBudgetGuardrail = {
  hourlyLimit: number;
  usedLastHour: number;
  remainingLastHour: number;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function parseIntEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (Number.isNaN(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

export function getHighRiskThreshold() {
  return parseIntEnv("GOVERNANCE_HIGH_RISK_THRESHOLD", 70, 0, 100);
}

export function getHourlyExecutionLimit() {
  return parseIntEnv("GOVERNANCE_HOURLY_SEND_EMAIL_LIMIT", 10, 1, 500);
}

export function getRequiredApprovalCountForRisk(riskScore: number) {
  const threshold = getHighRiskThreshold();
  return riskScore >= threshold ? 2 : 0;
}

export async function getDistinctApprovedApproverCount(args: {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
  excludeUserId?: string | null;
}) {
  const { supabase, orgId, taskId, excludeUserId = null } = args;
  const { data, error } = await supabase
    .from("approvals")
    .select("approver_user_id")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .eq("status", "approved");
  if (error) {
    throw new Error(`approved approvers query failed: ${error.message}`);
  }

  const distinct = new Set<string>();
  for (const row of data ?? []) {
    const approver = typeof row.approver_user_id === "string" ? row.approver_user_id : null;
    if (!approver) continue;
    if (excludeUserId && approver === excludeUserId) continue;
    distinct.add(approver);
  }
  return distinct.size;
}

export async function getTaskCreatorUserId(args: {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
}) {
  const { data, error } = await args.supabase
    .from("tasks")
    .select("created_by_user_id")
    .eq("org_id", args.orgId)
    .eq("id", args.taskId)
    .maybeSingle();
  if (error) {
    throw new Error(`task creator query failed: ${error.message}`);
  }
  return (data?.created_by_user_id as string | null | undefined) ?? null;
}

export async function evaluateApprovalGuardrail(args: {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
  riskScore: number;
}) {
  const highRiskThreshold = getHighRiskThreshold();
  const requiredApprovals = getRequiredApprovalCountForRisk(args.riskScore);
  const creatorUserId = await getTaskCreatorUserId({
    supabase: args.supabase,
    orgId: args.orgId,
    taskId: args.taskId
  });
  const distinctApproverCount = await getDistinctApprovedApproverCount({
    supabase: args.supabase,
    orgId: args.orgId,
    taskId: args.taskId,
    excludeUserId: creatorUserId
  });

  return {
    distinctApproverCount,
    requiredApprovals,
    highRiskThreshold,
    isHighRisk: args.riskScore >= highRiskThreshold
  } satisfies ApprovalGuardrailContext;
}

export async function inferTaskRiskScore(args: {
  supabase: SupabaseClient;
  orgId: string;
  taskId: string;
}) {
  const { supabase, orgId, taskId } = args;
  const { data: latestRisk, error: latestRiskError } = await supabase
    .from("risk_assessments")
    .select("risk_score")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestRiskError) {
    if (!isMissingTableError(latestRiskError.message, "risk_assessments")) {
      throw new Error(`risk assessment query failed: ${latestRiskError.message}`);
    }
  }

  const latestRiskScore = Number(latestRisk?.risk_score ?? NaN);
  if (Number.isFinite(latestRiskScore)) {
    return Math.max(0, Math.min(100, Math.round(latestRiskScore)));
  }

  const [{ data: latestPolicy, error: policyError }, { data: latestModel, error: modelError }] =
    await Promise.all([
      supabase
        .from("task_events")
        .select("payload_json")
        .eq("org_id", orgId)
        .eq("task_id", taskId)
        .eq("event_type", "POLICY_CHECKED")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("task_events")
        .select("payload_json")
        .eq("org_id", orgId)
        .eq("task_id", taskId)
        .eq("event_type", "MODEL_INFERRED")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);
  if (policyError) {
    throw new Error(`policy event query failed: ${policyError.message}`);
  }
  if (modelError) {
    throw new Error(`model event query failed: ${modelError.message}`);
  }

  const policyPayload = asObject(latestPolicy?.payload_json);
  const policyStatus = policyPayload?.status;
  const modelPayload = asObject(latestModel?.payload_json);
  const output = asObject(modelPayload?.output);
  const riskCount = Array.isArray(output?.risks)
    ? output?.risks.filter((item): item is string => typeof item === "string").length
    : 0;

  const score = Math.min(
    100,
    20 + (policyStatus === "block" ? 50 : policyStatus === "warn" ? 15 : 0) + Math.min(20, riskCount * 5)
  );
  return score;
}

export async function evaluateHourlyBudgetGuardrail(args: {
  supabase: SupabaseClient;
  orgId: string;
  provider: "google";
  actionType: "send_email";
}) {
  const hourlyLimit = getHourlyExecutionLimit();
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error } = await args.supabase
    .from("actions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", args.orgId)
    .eq("provider", args.provider)
    .eq("action_type", args.actionType)
    .eq("status", "success")
    .gte("created_at", sinceIso);

  if (error) {
    throw new Error(`hourly budget query failed: ${error.message}`);
  }

  const usedLastHour = count ?? 0;
  return {
    hourlyLimit,
    usedLastHour,
    remainingLastHour: Math.max(0, hourlyLimit - usedLastHour)
  } satisfies HourlyBudgetGuardrail;
}
