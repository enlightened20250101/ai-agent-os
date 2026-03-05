import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftOutput } from "@/lib/llm/openai";
import { checkDraftPolicy } from "@/lib/policy/check";

type PlannerSignal = {
  kind: "stale_tasks" | "recent_action_failures" | "stale_pending_approvals" | "policy_warn_block";
  title: string;
  details: string;
  count: number;
};

type PlannerProposal = {
  source: string;
  title: string;
  rationale: string;
  summary: string;
  proposed_actions: DraftOutput["proposed_actions"];
  risks: string[];
};

type ProposalPolicyStatus = "pass" | "warn" | "block";
type ProposalDecisionStatus = "accepted" | "rejected" | "proposed";

type ProposalFeedbackStats = {
  windowDays: number;
  acceptedCount: number;
  rejectedCount: number;
  decidedCount: number;
  acceptanceRate: number;
  rejectionRate: number;
  topRejectReasons: Array<{ reason: string; count: number }>;
  effectiveMaxProposals: number;
};

type RunPlannerArgs = {
  supabase: SupabaseClient;
  orgId: string;
  actorUserId?: string | null;
  maxProposals?: number;
};

type RunPlannerResult = {
  plannerRunId: string;
  createdProposals: number;
  consideredSignals: number;
  status: "completed" | "failed";
};

function isMissingColumnError(message: string, columnName: string) {
  return (
    message.includes(`Could not find the '${columnName}' column`) ||
    message.includes(`column task_proposals.${columnName} does not exist`)
  );
}

function getAllowedDomainForProposal() {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw) return "example.com";
  return (
    raw
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)[0] ?? "example.com"
  );
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseDecisionReasonPrefix(reason: unknown) {
  if (typeof reason !== "string" || !reason.trim()) return "unspecified";
  const idx = reason.indexOf(":");
  return (idx >= 0 ? reason.slice(0, idx) : reason).trim() || "unspecified";
}

async function buildProposalFeedback(args: {
  supabase: SupabaseClient;
  orgId: string;
  requestedMaxProposals: number;
}): Promise<ProposalFeedbackStats> {
  const { supabase, orgId } = args;
  const windowDays = Number(process.env.PLANNER_FEEDBACK_WINDOW_DAYS ?? "14");
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("task_proposals")
    .select("status, decision_reason, created_at")
    .eq("org_id", orgId)
    .in("status", ["accepted", "rejected"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) {
    throw new Error(`proposal_feedback query failed: ${error.message}`);
  }

  const feedbackRows = (rows ?? []) as Array<{
    status: ProposalDecisionStatus;
    decision_reason?: string | null;
  }>;
  const acceptedCount = feedbackRows.filter((row) => row.status === "accepted").length;
  const rejectedCount = feedbackRows.filter((row) => row.status === "rejected").length;
  const decidedCount = acceptedCount + rejectedCount;
  const acceptanceRate = decidedCount > 0 ? Math.round((acceptedCount / decidedCount) * 100) : 0;
  const rejectionRate = decidedCount > 0 ? Math.round((rejectedCount / decidedCount) * 100) : 0;

  const reasonCounts = new Map<string, number>();
  for (const row of feedbackRows) {
    if (row.status !== "rejected") continue;
    const prefix = parseDecisionReasonPrefix(row.decision_reason);
    reasonCounts.set(prefix, (reasonCounts.get(prefix) ?? 0) + 1);
  }
  const topRejectReasons = Array.from(reasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  let effectiveMaxProposals = args.requestedMaxProposals;
  if (decidedCount >= 8 && rejectionRate >= 70) {
    effectiveMaxProposals = Math.max(1, Math.min(args.requestedMaxProposals, 1));
  } else if (decidedCount >= 8 && rejectionRate >= 50) {
    effectiveMaxProposals = Math.max(1, Math.min(args.requestedMaxProposals, 2));
  }

  return {
    windowDays,
    acceptedCount,
    rejectedCount,
    decidedCount,
    acceptanceRate,
    rejectionRate,
    topRejectReasons,
    effectiveMaxProposals
  };
}

function normalizePlannerProposals(raw: unknown): PlannerProposal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const row = item as Record<string, unknown>;
      const source = typeof row.source === "string" ? row.source : "planner_openai";
      const title = typeof row.title === "string" ? row.title : "";
      const rationale = typeof row.rationale === "string" ? row.rationale : "";
      const summary = typeof row.summary === "string" ? row.summary : title;
      const risks = Array.isArray(row.risks)
        ? row.risks.filter((r): r is string => typeof r === "string")
        : [];
      const proposedRaw = Array.isArray(row.proposed_actions) ? row.proposed_actions : [];
      const proposedActions = proposedRaw
        .map((action) => {
          if (typeof action !== "object" || action === null) return null;
          const a = action as Record<string, unknown>;
          if (
            a.provider !== "google" ||
            a.action_type !== "send_email" ||
            typeof a.to !== "string" ||
            typeof a.subject !== "string" ||
            typeof a.body_text !== "string"
          ) {
            return null;
          }
          return {
            provider: "google" as const,
            action_type: "send_email" as const,
            to: a.to,
            subject: a.subject,
            body_text: a.body_text
          };
        })
        .filter((v): v is DraftOutput["proposed_actions"][number] => v !== null);

      if (!title || !rationale || proposedActions.length === 0) return null;
      return {
        source,
        title,
        rationale,
        summary,
        proposed_actions: proposedActions,
        risks
      };
    })
    .filter((v): v is PlannerProposal => v !== null);
}

async function buildSignals(args: { supabase: SupabaseClient; orgId: string }): Promise<PlannerSignal[]> {
  const { supabase, orgId } = args;
  const staleHours = Number(process.env.PLANNER_STALE_HOURS ?? "6");
  const staleCutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    staleTasksRes,
    failedEventsRes,
    staleApprovalsRes,
    policyEventsRes
  ] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, created_at")
      .eq("org_id", orgId)
      .in("status", ["draft", "ready_for_approval"])
      .lt("created_at", staleCutoff)
      .order("created_at", { ascending: true })
      .limit(20),
    supabase
      .from("task_events")
      .select("id, task_id, created_at")
      .eq("org_id", orgId)
      .eq("event_type", "ACTION_FAILED")
      .gte("created_at", last24h)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("approvals")
      .select("id, task_id, created_at")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .lt("created_at", staleCutoff)
      .order("created_at", { ascending: true })
      .limit(20),
    supabase
      .from("task_events")
      .select("id, task_id, payload_json, created_at")
      .eq("org_id", orgId)
      .eq("event_type", "POLICY_CHECKED")
      .gte("created_at", last24h)
      .order("created_at", { ascending: false })
      .limit(30)
  ]);

  if (staleTasksRes.error) throw new Error(`stale_tasks query failed: ${staleTasksRes.error.message}`);
  if (failedEventsRes.error)
    throw new Error(`action_failed query failed: ${failedEventsRes.error.message}`);
  if (staleApprovalsRes.error)
    throw new Error(`stale_approvals query failed: ${staleApprovalsRes.error.message}`);
  if (policyEventsRes.error)
    throw new Error(`policy_checked query failed: ${policyEventsRes.error.message}`);

  const signals: PlannerSignal[] = [];
  const staleTasks = staleTasksRes.data ?? [];
  if (staleTasks.length > 0) {
    signals.push({
      kind: "stale_tasks",
      title: "Stale draft/approval tasks",
      details: `${staleTasks.length} tasks are older than ${staleHours}h in draft/ready_for_approval.`,
      count: staleTasks.length
    });
  }

  const failedEvents = failedEventsRes.data ?? [];
  if (failedEvents.length > 0) {
    signals.push({
      kind: "recent_action_failures",
      title: "Recent failed action executions",
      details: `${failedEvents.length} ACTION_FAILED events in the last 24h.`,
      count: failedEvents.length
    });
  }

  const staleApprovals = staleApprovalsRes.data ?? [];
  if (staleApprovals.length > 0) {
    signals.push({
      kind: "stale_pending_approvals",
      title: "Stale pending approvals",
      details: `${staleApprovals.length} approvals pending for more than ${staleHours}h.`,
      count: staleApprovals.length
    });
  }

  const policyWarnBlock = (policyEventsRes.data ?? []).filter((event) => {
    const payload =
      typeof event.payload_json === "object" && event.payload_json !== null
        ? (event.payload_json as Record<string, unknown>)
        : null;
    return payload?.status === "warn" || payload?.status === "block";
  });
  if (policyWarnBlock.length > 0) {
    signals.push({
      kind: "policy_warn_block",
      title: "Policy warnings/blocks",
      details: `${policyWarnBlock.length} POLICY_CHECKED events are warn/block in the last 24h.`,
      count: policyWarnBlock.length
    });
  }

  return signals;
}

function makeStubProposals(args: { signals: PlannerSignal[]; maxProposals: number }): PlannerProposal[] {
  const domain = getAllowedDomainForProposal();
  const countText = args.signals.length > 0 ? `${args.signals.length} detected signals` : "no major signals";
  return [
    {
      source: "planner_stub",
      title: "Proactive vendor follow-up draft",
      rationale: `Planner detected ${countText} and suggests a concise outbound status update draft.`,
      summary: "Send a proactive status update to reduce pending operations backlogs.",
      proposed_actions: [
        {
          provider: "google" as const,
          action_type: "send_email" as const,
          to: `ops@${domain}`,
          subject: "Status update from AI Agent OS planner",
          body_text:
            "Hello,\n\nThis is a proactive status update from AI Agent OS planner regarding pending workflow items.\n\nRegards"
        }
      ],
      risks: ["Verify recipient before sending proactive communications."]
    }
  ].slice(0, args.maxProposals);
}

function clampScore(value: number) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function calculatePriorityScore(args: {
  proposal: PlannerProposal;
  signals: PlannerSignal[];
  policyStatus: ProposalPolicyStatus;
}) {
  const signalWeightByKind: Record<PlannerSignal["kind"], number> = {
    stale_tasks: 4,
    recent_action_failures: 8,
    stale_pending_approvals: 6,
    policy_warn_block: 5
  };

  const signalContribution = args.signals.reduce((sum, signal) => {
    return sum + signal.count * signalWeightByKind[signal.kind];
  }, 0);
  const riskPenalty = args.policyStatus === "block" ? 25 : args.policyStatus === "warn" ? 10 : 0;
  const proposalRiskPenalty = Math.min(20, args.proposal.risks.length * 5);
  return clampScore(35 + signalContribution - riskPenalty - proposalRiskPenalty);
}

function estimateProposalImpact(args: { signals: PlannerSignal[]; proposal: PlannerProposal }) {
  const signalCount = args.signals.reduce((sum, signal) => sum + signal.count, 0);
  const to = args.proposal.proposed_actions[0]?.to ?? "";
  const toDomain = to.includes("@") ? to.split("@")[1]?.toLowerCase() ?? null : null;
  return {
    affected_work_items: signalCount,
    likely_time_saved_minutes: Math.min(240, 15 + signalCount * 4),
    external_communication: Boolean(toDomain && toDomain !== "example.com"),
    primary_signal_kinds: args.signals.map((signal) => signal.kind)
  };
}

async function generateProposalsWithOpenAI(args: {
  signals: PlannerSignal[];
  maxProposals: number;
  feedback: ProposalFeedbackStats;
}): Promise<PlannerProposal[]> {
  if (process.env.E2E_MODE === "1") {
    return makeStubProposals(args);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return makeStubProposals(args);
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const domain = getAllowedDomainForProposal();
  const prompt = [
    "You are an autonomous workflow planner for an operations inbox.",
    "Return JSON only. No markdown.",
    "Output must be an array with up to max_proposals items.",
    "Each item shape:",
    `{ "source": "planner_openai", "title": string, "rationale": string, "summary": string, "proposed_actions": [{ "provider": "google", "action_type": "send_email", "to": string, "subject": string, "body_text": string }], "risks": string[] }`,
    "Rules:",
    "- proposed_actions must not be empty.",
    "- provider/action_type fixed to google/send_email.",
    `- Prefer recipient domain ${domain}.`,
    `max_proposals=${args.maxProposals}`,
    `signals=${JSON.stringify(args.signals)}`,
    `feedback=${JSON.stringify({
      window_days: args.feedback.windowDays,
      acceptance_rate: args.feedback.acceptanceRate,
      rejection_rate: args.feedback.rejectionRate,
      top_reject_reasons: args.feedback.topRejectReasons
    })}`
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "You output strict JSON arrays only."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Planner OpenAI request failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Planner OpenAI returned empty content.");
  }
  const parsed = safeJsonParse(content);
  const normalized = normalizePlannerProposals(parsed);
  if (normalized.length === 0) {
    return makeStubProposals(args);
  }
  return normalized.slice(0, args.maxProposals);
}

async function appendProposalEvent(args: {
  supabase: SupabaseClient;
  orgId: string;
  proposalId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const { error } = await args.supabase.from("proposal_events").insert({
    org_id: args.orgId,
    proposal_id: args.proposalId ?? null,
    event_type: args.eventType,
    payload_json: args.payload
  });
  if (error) {
    throw new Error(`Failed to append proposal event ${args.eventType}: ${error.message}`);
  }
}

export async function runPlanner(args: RunPlannerArgs): Promise<RunPlannerResult> {
  const { supabase, orgId, actorUserId = null, maxProposals = 3 } = args;
  const startedAt = new Date().toISOString();

  const { data: plannerRun, error: plannerRunError } = await supabase
    .from("planner_runs")
    .insert({
      org_id: orgId,
      status: "running",
      started_at: startedAt
    })
    .select("id")
    .single();
  if (plannerRunError) {
    throw new Error(`Failed to create planner run: ${plannerRunError.message}`);
  }
  const plannerRunId = plannerRun.id as string;

  await appendProposalEvent({
    supabase,
    orgId,
    proposalId: null,
    eventType: "PLANNER_RUN_STARTED",
    payload: {
      planner_run_id: plannerRunId,
      actor_user_id: actorUserId
    }
  });

  try {
    const signals = await buildSignals({ supabase, orgId });
    const feedback = await buildProposalFeedback({
      supabase,
      orgId,
      requestedMaxProposals: maxProposals
    });
    const proposals = await generateProposalsWithOpenAI({
      signals,
      maxProposals: feedback.effectiveMaxProposals,
      feedback
    });

    let createdCount = 0;
    for (const proposal of proposals) {
      const draftForPolicy: DraftOutput = {
        summary: proposal.summary,
        proposed_actions: proposal.proposed_actions,
        risks: proposal.risks
      };
      const policy = checkDraftPolicy({ draft: draftForPolicy });
      const policyStatus = policy.result.status as ProposalPolicyStatus;
      const priorityScore = calculatePriorityScore({
        proposal,
        signals,
        policyStatus
      });
      const estimatedImpact = estimateProposalImpact({
        signals,
        proposal
      });
      let { data: createdProposal, error: proposalError } = await supabase
        .from("task_proposals")
        .insert({
          org_id: orgId,
          planner_run_id: plannerRunId,
          source: proposal.source,
          title: proposal.title,
          rationale: proposal.rationale,
          proposed_actions_json: proposal.proposed_actions,
          risks_json: proposal.risks,
          policy_status: policyStatus,
          policy_reasons: policy.result.reasons,
          priority_score: priorityScore,
          estimated_impact_json: estimatedImpact,
          status: "proposed"
        })
        .select("id")
        .single();

      if (
        proposalError &&
        (isMissingColumnError(proposalError.message, "planner_run_id") ||
          isMissingColumnError(proposalError.message, "priority_score") ||
          isMissingColumnError(proposalError.message, "estimated_impact_json"))
      ) {
        const retry = await supabase
          .from("task_proposals")
          .insert({
            org_id: orgId,
            source: proposal.source,
            title: proposal.title,
            rationale: proposal.rationale,
            proposed_actions_json: proposal.proposed_actions,
            risks_json: proposal.risks,
            policy_status: policyStatus,
            policy_reasons: policy.result.reasons,
            status: "proposed"
          })
          .select("id")
          .single();
        createdProposal = retry.data;
        proposalError = retry.error;
      }

      if (proposalError) {
        throw new Error(`Failed to create proposal: ${proposalError.message}`);
      }
      const createdProposalId = createdProposal?.id as string | undefined;
      if (!createdProposalId) {
        throw new Error("Failed to create proposal: missing proposal id.");
      }

      createdCount += 1;
      await appendProposalEvent({
        supabase,
        orgId,
        proposalId: createdProposalId,
        eventType: "PROPOSAL_CREATED",
        payload: {
          planner_run_id: plannerRunId,
          source: proposal.source,
          policy_status: policyStatus,
          policy_reasons: policy.result.reasons,
          priority_score: priorityScore,
          estimated_impact: estimatedImpact
        }
      });
    }

    const finishedAt = new Date().toISOString();
    const summaryJson = {
      created_proposals: createdCount,
      requested_max_proposals: maxProposals,
      effective_max_proposals: feedback.effectiveMaxProposals,
      considered_signals: signals.length,
      total_signal_items: signals.reduce((sum, signal) => sum + signal.count, 0),
      feedback: {
        window_days: feedback.windowDays,
        accepted_count: feedback.acceptedCount,
        rejected_count: feedback.rejectedCount,
        decided_count: feedback.decidedCount,
        acceptance_rate: feedback.acceptanceRate,
        rejection_rate: feedback.rejectionRate,
        top_reject_reasons: feedback.topRejectReasons
      },
      signal_breakdown: signals.map((signal) => ({
        kind: signal.kind,
        count: signal.count
      }))
    };

    const { error: updateError } = await supabase
      .from("planner_runs")
      .update({
        status: "completed",
        finished_at: finishedAt,
        summary_json: summaryJson
      })
      .eq("id", plannerRunId)
      .eq("org_id", orgId);
    if (updateError) {
      throw new Error(`Failed to finalize planner run: ${updateError.message}`);
    }

    await appendProposalEvent({
      supabase,
      orgId,
      proposalId: null,
      eventType: "PLANNER_RUN_FINISHED",
      payload: {
        planner_run_id: plannerRunId,
        status: "completed",
        summary: summaryJson
      }
    });

    return {
      plannerRunId,
      createdProposals: createdCount,
      consideredSignals: signals.length,
      status: "completed"
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const summary = {
      error: error instanceof Error ? error.message.slice(0, 240) : "Unknown planner error."
    };
    await supabase
      .from("planner_runs")
      .update({
        status: "failed",
        finished_at: finishedAt,
        summary_json: summary
      })
      .eq("id", plannerRunId)
      .eq("org_id", orgId);

    await appendProposalEvent({
      supabase,
      orgId,
      proposalId: null,
      eventType: "PLANNER_RUN_FINISHED",
      payload: {
        planner_run_id: plannerRunId,
        status: "failed",
        summary
      }
    });

    throw error;
  }
}
