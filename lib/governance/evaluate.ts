import type { SupabaseClient } from "@supabase/supabase-js";
import { getLatestOpenIncident } from "@/lib/governance/incidents";
import {
  evaluateApprovalGuardrail,
  evaluateHourlyBudgetGuardrail
} from "@/lib/governance/guardrails";

export type AutonomyLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export type GovernanceSettings = {
  autonomyLevel: AutonomyLevel;
  autoExecuteGoogleSendEmail: boolean;
  maxAutoExecuteRiskScore: number;
  minTrustScore: number;
  dailySendEmailLimit: number;
};

export type GovernanceEvaluationInput = {
  supabase: SupabaseClient;
  orgId: string;
  taskId?: string | null;
  proposalId?: string | null;
  provider: "google";
  actionType: "send_email";
  to: string;
  subject: string;
  bodyText: string;
  policyStatus: "pass" | "warn" | "block";
  agentRoleKey?: string | null;
  persistAssessment?: boolean;
};

export type GovernanceDecision = "allow_auto_execute" | "require_approval" | "block";

export type GovernanceEvaluation = {
  decision: GovernanceDecision;
  reasons: string[];
  riskScore: number;
  trustScore: number;
  remainingBudget: number | null;
  settings: GovernanceSettings;
  dimensions: {
    data_sensitivity: "low" | "medium" | "high";
    monetary_impact: "low" | "medium" | "high";
    externality: "internal" | "customer_facing";
    reversibility: "reversible" | "hard_to_reverse";
    past_reliability: "low" | "medium" | "high";
  };
  guardrails: {
    requiredApprovals: number;
    distinctApproverCount: number | null;
    hourlyLimit: number;
    hourlyUsed: number;
    hourlyRemaining: number;
  };
};

const DEFAULT_SETTINGS: GovernanceSettings = {
  autonomyLevel: "L1",
  autoExecuteGoogleSendEmail: false,
  maxAutoExecuteRiskScore: 25,
  minTrustScore: 80,
  dailySendEmailLimit: 20
};

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function domainFromEmail(email: string) {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at >= email.length - 1) {
    return null;
  }
  return email.slice(at + 1).toLowerCase();
}

function isLikelyPiiText(text: string) {
  const phone = /\b(?:\+?\d{1,3}[\s.-]?)?(?:\d[\s.-]?){9,12}\b/.test(text);
  const card = /\b(?:\d[ -]*?){13,19}\b/.test(text);
  return phone || card;
}

function includesMonetaryText(text: string) {
  return /\b(?:\$|¥|EUR|USD|JPY|invoice|請求|支払い|payment|amount)\b/i.test(text);
}

function parseSettingsRow(row: Record<string, unknown> | null): GovernanceSettings {
  if (!row) {
    return { ...DEFAULT_SETTINGS };
  }
  const autonomyLevel =
    row.autonomy_level === "L0" ||
    row.autonomy_level === "L1" ||
    row.autonomy_level === "L2" ||
    row.autonomy_level === "L3" ||
    row.autonomy_level === "L4"
      ? row.autonomy_level
      : DEFAULT_SETTINGS.autonomyLevel;

  return {
    autonomyLevel,
    autoExecuteGoogleSendEmail:
      typeof row.auto_execute_google_send_email === "boolean"
        ? row.auto_execute_google_send_email
        : DEFAULT_SETTINGS.autoExecuteGoogleSendEmail,
    maxAutoExecuteRiskScore:
      typeof row.max_auto_execute_risk_score === "number"
        ? row.max_auto_execute_risk_score
        : DEFAULT_SETTINGS.maxAutoExecuteRiskScore,
    minTrustScore:
      typeof row.min_trust_score === "number" ? row.min_trust_score : DEFAULT_SETTINGS.minTrustScore,
    dailySendEmailLimit:
      typeof row.daily_send_email_limit === "number"
        ? row.daily_send_email_limit
        : DEFAULT_SETTINGS.dailySendEmailLimit
  };
}

export async function getGovernanceSettings(args: {
  supabase: SupabaseClient;
  orgId: string;
}): Promise<GovernanceSettings> {
  const { data, error } = await args.supabase
    .from("org_autonomy_settings")
    .select(
      "autonomy_level, auto_execute_google_send_email, max_auto_execute_risk_score, min_trust_score, daily_send_email_limit"
    )
    .eq("org_id", args.orgId)
    .maybeSingle();

  if (error) {
    const message = error.message ?? "";
    if (
      message.includes('relation "org_autonomy_settings" does not exist') ||
      message.includes("Could not find the table 'public.org_autonomy_settings'")
    ) {
      return { ...DEFAULT_SETTINGS };
    }
    throw new Error(`governance settings query failed: ${error.message}`);
  }

  return parseSettingsRow((data as Record<string, unknown> | null) ?? null);
}

async function getTrustScore(args: {
  supabase: SupabaseClient;
  orgId: string;
  provider: "google";
  actionType: "send_email";
  agentRoleKey?: string | null;
}) {
  const { data, error } = await args.supabase
    .from("trust_scores")
    .select("score, provider, action_type, agent_role_key, updated_at")
    .eq("org_id", args.orgId)
    .or(
      `and(provider.eq.${args.provider},action_type.eq.${args.actionType}),and(provider.is.null,action_type.is.null)`
    )
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error) {
    const message = error.message ?? "";
    if (
      message.includes('relation "trust_scores" does not exist') ||
      message.includes("Could not find the table 'public.trust_scores'")
    ) {
      return 60;
    }
    throw new Error(`trust score query failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    score: number;
    provider: "google" | null;
    action_type: string | null;
    agent_role_key: string | null;
  }>;

  const exactRole =
    args.agentRoleKey && rows.find((row) => row.agent_role_key === args.agentRoleKey && row.provider);
  if (exactRole) {
    return exactRole.score;
  }
  const exactAction = rows.find((row) => row.provider === args.provider && row.action_type === args.actionType);
  if (exactAction) {
    return exactAction.score;
  }
  const generic = rows.find((row) => row.provider === null && row.action_type === null);
  return generic?.score ?? 60;
}

async function getRemainingBudget(args: {
  supabase: SupabaseClient;
  orgId: string;
  provider: "google";
  actionType: "send_email";
  defaultLimit: number;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [limitRes, usageRes] = await Promise.all([
    args.supabase
      .from("budget_limits")
      .select("limit_count")
      .eq("org_id", args.orgId)
      .eq("provider", args.provider)
      .eq("action_type", args.actionType)
      .eq("period", "daily")
      .maybeSingle(),
    args.supabase
      .from("budget_usage")
      .select("used_count")
      .eq("org_id", args.orgId)
      .eq("provider", args.provider)
      .eq("action_type", args.actionType)
      .eq("usage_date", today)
      .maybeSingle()
  ]);

  const missingTable = (message: string) =>
    message.includes('relation "budget_limits" does not exist') ||
    message.includes('relation "budget_usage" does not exist') ||
    message.includes("Could not find the table 'public.budget_limits'") ||
    message.includes("Could not find the table 'public.budget_usage'");

  if (limitRes.error && !missingTable(limitRes.error.message)) {
    throw new Error(`budget limit query failed: ${limitRes.error.message}`);
  }
  if (usageRes.error && !missingTable(usageRes.error.message)) {
    throw new Error(`budget usage query failed: ${usageRes.error.message}`);
  }

  const limit = (limitRes.data?.limit_count as number | undefined) ?? args.defaultLimit;
  const used = (usageRes.data?.used_count as number | undefined) ?? 0;
  return Math.max(0, limit - used);
}

function buildRiskModel(args: {
  to: string;
  subject: string;
  bodyText: string;
  policyStatus: "pass" | "warn" | "block";
  trustScore: number;
}) {
  const text = `${args.subject}\n${args.bodyText}`;
  const pii = isLikelyPiiText(text);
  const money = includesMonetaryText(text);

  const dataSensitivity: "low" | "medium" | "high" = pii ? "high" : "medium";
  const monetaryImpact: "low" | "medium" | "high" = money ? "high" : "medium";
  const externality: "internal" | "customer_facing" = "customer_facing";
  const reversibility: "reversible" | "hard_to_reverse" = "hard_to_reverse";
  const pastReliability: "low" | "medium" | "high" =
    args.trustScore >= 85 ? "high" : args.trustScore >= 65 ? "medium" : "low";

  let score = 20;
  if (args.policyStatus === "warn") {
    score += 15;
  }
  if (args.policyStatus === "block") {
    score += 50;
  }
  if (pii) {
    score += 25;
  }
  if (money) {
    score += 20;
  }

  if (pastReliability === "low") {
    score += 10;
  } else if (pastReliability === "high") {
    score -= 5;
  }

  const domain = domainFromEmail(args.to);
  if (!domain) {
    score += 20;
  }

  return {
    score: clampScore(score),
    dimensions: {
      data_sensitivity: dataSensitivity,
      monetary_impact: monetaryImpact,
      externality: externality,
      reversibility: reversibility,
      past_reliability: pastReliability
    }
  };
}

async function saveRiskAssessment(args: {
  supabase: SupabaseClient;
  orgId: string;
  taskId?: string | null;
  proposalId?: string | null;
  fingerprint: string;
  riskScore: number;
  dimensions: GovernanceEvaluation["dimensions"];
  metadata: Record<string, unknown>;
}) {
  const { error } = await args.supabase.from("risk_assessments").insert({
    org_id: args.orgId,
    task_id: args.taskId ?? null,
    proposal_id: args.proposalId ?? null,
    action_fingerprint: args.fingerprint,
    risk_score: args.riskScore,
    dimensions_json: {
      ...args.dimensions,
      ...args.metadata
    }
  });

  if (error) {
    const message = error.message ?? "";
    if (
      message.includes('relation "risk_assessments" does not exist') ||
      message.includes("Could not find the table 'public.risk_assessments'")
    ) {
      return;
    }
    throw new Error(`risk assessment insert failed: ${error.message}`);
  }
}

function buildFingerprint(args: {
  provider: "google";
  actionType: "send_email";
  to: string;
  subject: string;
  bodyText: string;
}) {
  const normalized = [
    args.provider,
    args.actionType,
    args.to.trim().toLowerCase(),
    args.subject.trim(),
    args.bodyText.trim()
  ].join("|");

  return Buffer.from(normalized).toString("base64").slice(0, 240);
}

export async function evaluateGovernance(args: GovernanceEvaluationInput): Promise<GovernanceEvaluation> {
  const settings = await getGovernanceSettings({ supabase: args.supabase, orgId: args.orgId });
  const latestOpenIncident = await getLatestOpenIncident({ supabase: args.supabase, orgId: args.orgId });
  const trustScore = await getTrustScore({
    supabase: args.supabase,
    orgId: args.orgId,
    provider: args.provider,
    actionType: args.actionType,
    agentRoleKey: args.agentRoleKey
  });

  const risk = buildRiskModel({
    to: args.to,
    subject: args.subject,
    bodyText: args.bodyText,
    policyStatus: args.policyStatus,
    trustScore
  });

  const remainingBudget = await getRemainingBudget({
    supabase: args.supabase,
    orgId: args.orgId,
    provider: args.provider,
    actionType: args.actionType,
    defaultLimit: settings.dailySendEmailLimit
  });
  const hourlyGuardrail = await evaluateHourlyBudgetGuardrail({
    supabase: args.supabase,
    orgId: args.orgId,
    provider: args.provider,
    actionType: args.actionType
  });

  const reasons: string[] = [];
  let decision: GovernanceDecision = "require_approval";
  let requiredApprovals = 1;
  let distinctApproverCount: number | null = null;

  if (args.taskId) {
    const approvalGuardrail = await evaluateApprovalGuardrail({
      supabase: args.supabase,
      orgId: args.orgId,
      taskId: args.taskId,
      riskScore: risk.score
    });
    requiredApprovals = approvalGuardrail.requiredApprovals;
    distinctApproverCount = approvalGuardrail.distinctApproverCount;
    if (distinctApproverCount < requiredApprovals) {
      reasons.push(
        `承認者数が不足しています（必要=${requiredApprovals}, 現在=${distinctApproverCount}）。`
      );
    }
  } else {
    requiredApprovals = risk.score >= 70 ? 2 : 0;
  }

  if (latestOpenIncident) {
    decision = "block";
    reasons.push(
      `インシデントモード中のため自動実行停止です（severity=${latestOpenIncident.severity}）。`
    );
  }

  if (args.policyStatus === "block") {
    decision = "block";
    reasons.push("ポリシーステータスが block のため自動実行不可です。");
  }

  if (!settings.autoExecuteGoogleSendEmail) {
    reasons.push("自動実行トグルが無効です。");
  }

  if (settings.autonomyLevel !== "L3" && settings.autonomyLevel !== "L4") {
    reasons.push("組織の自律レベルが L3/L4 ではありません。");
  }

  if (risk.score > settings.maxAutoExecuteRiskScore) {
    reasons.push(
      `リスクスコア ${risk.score} が閾値 ${settings.maxAutoExecuteRiskScore} を超えています。`
    );
  }

  if (trustScore < settings.minTrustScore) {
    reasons.push(`Trust score ${trustScore} が最低値 ${settings.minTrustScore} 未満です。`);
  }

  if (remainingBudget <= 0) {
    reasons.push("当日実行予算が上限に達しています。");
  }
  if (hourlyGuardrail.remainingLastHour <= 0) {
    reasons.push(
      `1時間あたり実行上限に達しています（limit=${hourlyGuardrail.hourlyLimit}）。`
    );
  }

  if (
    decision !== "block" &&
    settings.autoExecuteGoogleSendEmail &&
    (settings.autonomyLevel === "L3" || settings.autonomyLevel === "L4") &&
    risk.score <= settings.maxAutoExecuteRiskScore &&
    trustScore >= settings.minTrustScore &&
    remainingBudget > 0 &&
    hourlyGuardrail.remainingLastHour > 0 &&
    (distinctApproverCount === null || distinctApproverCount >= requiredApprovals)
  ) {
    decision = "allow_auto_execute";
  }

  const fingerprint = buildFingerprint({
    provider: args.provider,
    actionType: args.actionType,
    to: args.to,
    subject: args.subject,
    bodyText: args.bodyText
  });

  if (args.persistAssessment !== false) {
    await saveRiskAssessment({
      supabase: args.supabase,
      orgId: args.orgId,
      taskId: args.taskId,
      proposalId: args.proposalId,
      fingerprint,
      riskScore: risk.score,
      dimensions: risk.dimensions,
      metadata: {
        policy_status: args.policyStatus,
        trust_score: trustScore,
        remaining_budget: remainingBudget,
        hourly_remaining: hourlyGuardrail.remainingLastHour,
        required_approvals: requiredApprovals,
        distinct_approvers: distinctApproverCount
      }
    });
  }

  return {
    decision,
    reasons,
    riskScore: risk.score,
    trustScore,
    remainingBudget,
    settings,
    dimensions: risk.dimensions,
    guardrails: {
      requiredApprovals,
      distinctApproverCount,
      hourlyLimit: hourlyGuardrail.hourlyLimit,
      hourlyUsed: hourlyGuardrail.usedLastHour,
      hourlyRemaining: hourlyGuardrail.remainingLastHour
    }
  };
}

export async function incrementBudgetUsage(args: {
  supabase: SupabaseClient;
  orgId: string;
  provider: "google";
  actionType: "send_email";
}) {
  const today = new Date().toISOString().slice(0, 10);
  const selectCurrent = async () =>
    args.supabase
      .from("budget_usage")
      .select("id, used_count")
      .eq("org_id", args.orgId)
      .eq("provider", args.provider)
      .eq("action_type", args.actionType)
      .eq("usage_date", today)
      .maybeSingle();

  const { data: current, error: queryError } = await selectCurrent();
  let currentRow = current;
  let currentError = queryError;

  if (currentError) {
    const message = currentError.message ?? "";
    if (
      message.includes('relation "budget_usage" does not exist') ||
      message.includes("Could not find the table 'public.budget_usage'")
    ) {
      return;
    }
    throw new Error(`budget usage query failed: ${currentError.message}`);
  }

  if (!currentRow?.id) {
    const { error: insertError } = await args.supabase.from("budget_usage").insert({
      org_id: args.orgId,
      provider: args.provider,
      action_type: args.actionType,
      usage_date: today,
      used_count: 1
    });
    if (!insertError) {
      return;
    }
    if (insertError.code !== "23505") {
      throw new Error(`budget usage insert failed: ${insertError.message}`);
    }
    const refetched = await selectCurrent();
    currentRow = refetched.data;
    currentError = refetched.error;
  }

  if (currentError) {
    throw new Error(`budget usage requery failed: ${currentError.message}`);
  }

  if (!currentRow?.id) {
    return;
  }

  const { error: updateError } = await args.supabase
    .from("budget_usage")
    .update({ used_count: Number(currentRow.used_count ?? 0) + 1, updated_at: new Date().toISOString() })
    .eq("id", currentRow.id as string)
    .eq("org_id", args.orgId);

  if (updateError) {
    throw new Error(`budget usage update failed: ${updateError.message}`);
  }
}
