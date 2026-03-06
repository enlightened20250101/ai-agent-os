import type { SupabaseClient } from "@supabase/supabase-js";
import { getOpsRuntimeSettings } from "@/lib/governance/opsRuntimeSettings";
import type { DraftOutput } from "@/lib/llm/openai";
import { checkDraftPolicy } from "@/lib/policy/check";

type PlannerSignal = {
  kind:
    | "stale_tasks"
    | "recent_action_failures"
    | "stale_pending_approvals"
    | "policy_warn_block"
    | "stale_open_cases"
    | "new_inbound_events";
  title: string;
  details: string;
  count: number;
  meta?: Record<string, unknown>;
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

type ExternalTemplateFeedback = {
  rankedTemplateKeys: string[];
  acceptanceRateByTemplate: Record<string, number>;
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

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
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

async function buildExternalTemplateFeedback(args: {
  supabase: SupabaseClient;
  orgId: string;
}): Promise<ExternalTemplateFeedback> {
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await args.supabase
    .from("task_proposals")
    .select("source, status, created_at")
    .eq("org_id", args.orgId)
    .gte("created_at", sinceIso)
    .in("status", ["accepted", "rejected"])
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    throw new Error(`external template feedback query failed: ${error.message}`);
  }

  const counters = new Map<string, { accepted: number; decided: number }>();
  for (const row of data ?? []) {
    const source = String(row.source ?? "");
    if (!source.startsWith("planner_seed_external_event_")) continue;
    const key = source.replace("planner_seed_external_event_", "");
    const current = counters.get(key) ?? { accepted: 0, decided: 0 };
    current.decided += 1;
    if (row.status === "accepted") current.accepted += 1;
    counters.set(key, current);
  }

  const entries = Array.from(counters.entries()).map(([key, value]) => ({
    key,
    accepted: value.accepted,
    decided: value.decided,
    rate: value.decided > 0 ? Math.round((value.accepted / value.decided) * 100) : 0
  }));
  entries.sort((a, b) => {
    if (b.rate !== a.rate) return b.rate - a.rate;
    return b.decided - a.decided;
  });

  return {
    rankedTemplateKeys: entries.map((entry) => entry.key),
    acceptanceRateByTemplate: Object.fromEntries(entries.map((entry) => [entry.key, entry.rate]))
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

async function buildSignals(args: { supabase: SupabaseClient; orgId: string; staleHours: number }): Promise<PlannerSignal[]> {
  const { supabase, orgId } = args;
  const staleHours = Math.max(1, Math.min(168, args.staleHours));
  const staleCutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    staleTasksRes,
    failedEventsRes,
    staleApprovalsRes,
    policyEventsRes,
    staleCasesRes,
    inboundEventsRes
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
      .limit(30),
    supabase
      .from("business_cases")
      .select("id, title, updated_at")
      .eq("org_id", orgId)
      .eq("status", "open")
      .lt("updated_at", staleCutoff)
      .order("updated_at", { ascending: true })
      .limit(20),
    supabase
      .from("external_events")
      .select("id, provider, event_type, summary_text, created_at")
      .eq("org_id", orgId)
      .eq("status", "new")
      .gte("created_at", last24h)
      .order("created_at", { ascending: false })
      .limit(20)
  ]);

  if (staleTasksRes.error) throw new Error(`stale_tasks query failed: ${staleTasksRes.error.message}`);
  if (failedEventsRes.error)
    throw new Error(`action_failed query failed: ${failedEventsRes.error.message}`);
  if (staleApprovalsRes.error)
    throw new Error(`stale_approvals query failed: ${staleApprovalsRes.error.message}`);
  if (policyEventsRes.error)
    throw new Error(`policy_checked query failed: ${policyEventsRes.error.message}`);
  if (staleCasesRes.error && !isMissingTableError(staleCasesRes.error.message, "business_cases")) {
    throw new Error(`stale_cases query failed: ${staleCasesRes.error.message}`);
  }
  if (inboundEventsRes.error && !isMissingTableError(inboundEventsRes.error.message, "external_events")) {
    throw new Error(`inbound_events query failed: ${inboundEventsRes.error.message}`);
  }

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

  const staleCases = staleCasesRes.error ? [] : (staleCasesRes.data ?? []);
  if (staleCases.length > 0) {
    signals.push({
      kind: "stale_open_cases",
      title: "Stale open cases",
      details: `${staleCases.length} open cases are stale for more than ${staleHours}h.`,
      count: staleCases.length,
      meta: {
        sample_case_titles: staleCases
          .map((row) => (typeof row.title === "string" ? row.title : ""))
          .filter((v) => v.trim().length > 0)
          .slice(0, 5)
      }
    });
  }

  const inboundEvents = inboundEventsRes.error ? [] : (inboundEventsRes.data ?? []);
  if (inboundEvents.length > 0) {
    signals.push({
      kind: "new_inbound_events",
      title: "New inbound events",
      details: `${inboundEvents.length} new inbound events arrived in the last 24h.`,
      count: inboundEvents.length,
      meta: {
        sample_events: inboundEvents.slice(0, 5).map((row) => ({
          provider: row.provider,
          event_type: row.event_type,
          summary: row.summary_text
        }))
      }
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

function pickSampleCaseTitles(signal: PlannerSignal | undefined): string[] {
  const raw = signal?.meta?.sample_case_titles;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 3);
}

function pickSampleInboundEvents(signal: PlannerSignal | undefined): Array<{
  provider: string;
  event_type: string;
  summary: string;
}> {
  const raw = signal?.meta?.sample_events;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const row = item as Record<string, unknown>;
      return {
        provider: typeof row.provider === "string" ? row.provider : "external",
        event_type: typeof row.event_type === "string" ? row.event_type : "EVENT",
        summary: typeof row.summary === "string" ? row.summary : ""
      };
    })
    .filter((v): v is { provider: string; event_type: string; summary: string } => v !== null)
    .slice(0, 5);
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function externalEventTemplate(args: {
  provider: string;
  eventType: string;
  summary: string;
  domain: string;
}) {
  const provider = args.provider.toLowerCase();
  const eventType = args.eventType.toLowerCase();
  const summary = args.summary.toLowerCase();
  const merged = `${eventType} ${summary}`;

  if (includesAny(merged, ["invoice", "payment", "purchase", "approval"])) {
    return {
      key: "finance",
      title: `経理確認: ${args.eventType}`,
      subject: `【経理対応】${args.eventType} の確認依頼`,
      body: `経理系の外部イベントを受信しました。一次確認をお願いします。\n\nprovider: ${args.provider}\nevent_type: ${args.eventType}\nsummary: ${args.summary || "要約なし"}\n\n必要に応じて承認・支払フローへ連携してください。`,
      risks: ["金額・取引先・承認経路を確認してから送信してください。"]
    };
  }
  if (includesAny(merged, ["incident", "security", "unauthorized", "breach", "fraud", "failed", "error"])) {
    return {
      key: "incident",
      title: `障害対応: ${args.eventType}`,
      subject: `【要緊急確認】${args.eventType} 検知`,
      body: `障害/セキュリティ系シグナルを受信しました。優先確認をお願いします。\n\nprovider: ${args.provider}\nevent_type: ${args.eventType}\nsummary: ${args.summary || "要約なし"}\n\n必要ならインシデントを起票し、関連実行を一時停止してください。`,
      risks: ["誤検知の可能性があるため、根拠ログを確認してからエスカレーションしてください。"]
    };
  }
  if (provider === "slack" && includesAny(merged, ["@ai", "mention", "request"])) {
    return {
      key: "chatops",
      title: `チャット依頼整理: ${args.eventType}`,
      subject: `【チャット依頼】${args.eventType} の一次整理`,
      body: `Slack由来の依頼シグナルを受信しました。\n\nprovider: ${args.provider}\nevent_type: ${args.eventType}\nsummary: ${args.summary || "要約なし"}\n\n依頼内容を確認し、必要なタスク化と担当割当を行ってください。`,
      risks: ["同一依頼の重複タスク化を避けるため既存タスクを確認してください。"]
    };
  }

  return {
    key: "general",
    title: `外部イベント対応: ${args.eventType}`,
    subject: `【外部イベント対応】${args.eventType} の確認依頼`,
    body: `外部イベントを受信しました。一次確認をお願いします。\n\nprovider: ${args.provider}\nevent_type: ${args.eventType}\nsummary: ${args.summary || "要約なし"}\n\n必要であればタスク化して対応してください。`,
    risks: ["外部イベントの一次情報が不十分な場合は送信前に内容を補完してください。"]
  };
}

function makeSeedProposals(args: {
  signals: PlannerSignal[];
  maxProposals: number;
  externalTemplateFeedback?: ExternalTemplateFeedback;
}): PlannerProposal[] {
  const domain = getAllowedDomainForProposal();
  const inboundSignal = args.signals.find((signal) => signal.kind === "new_inbound_events");
  const inboundSamples = pickSampleInboundEvents(inboundSignal);
  const staleCaseSignal = args.signals.find((signal) => signal.kind === "stale_open_cases");
  const staleCaseTitles = pickSampleCaseTitles(staleCaseSignal);
  const proposals: PlannerProposal[] = [];

  const inboundCandidates: PlannerProposal[] = [];
  for (const sample of inboundSamples) {
    const summaryLine = sample.summary.trim() || "要約なし";
    const template = externalEventTemplate({
      provider: sample.provider,
      eventType: sample.event_type,
      summary: summaryLine,
      domain
    });
    inboundCandidates.push({
      source: `planner_seed_external_event_${template.key}`,
      title: template.title,
      rationale: `${sample.provider} から受信したイベント（${sample.event_type}）を起点に、イベント種別に応じた一次対応を先行します。`,
      summary: `${sample.event_type} の一次対応案`,
      proposed_actions: [
        {
          provider: "google",
          action_type: "send_email",
          to: `ops@${domain}`,
          subject: template.subject,
          body_text: template.body
        }
      ],
      risks: template.risks
    });
  }
  const feedbackOrder = args.externalTemplateFeedback?.rankedTemplateKeys ?? [];
  const feedbackRateMap = args.externalTemplateFeedback?.acceptanceRateByTemplate ?? {};
  inboundCandidates.sort((a, b) => {
    const keyA = a.source.replace("planner_seed_external_event_", "");
    const keyB = b.source.replace("planner_seed_external_event_", "");
    const idxA = feedbackOrder.indexOf(keyA);
    const idxB = feedbackOrder.indexOf(keyB);
    if (idxA >= 0 || idxB >= 0) {
      if (idxA < 0) return 1;
      if (idxB < 0) return -1;
      if (idxA !== idxB) return idxA - idxB;
    }
    const rateA = feedbackRateMap[keyA] ?? 0;
    const rateB = feedbackRateMap[keyB] ?? 0;
    if (rateB !== rateA) return rateB - rateA;
    return 0;
  });
  for (const candidate of inboundCandidates) {
    if (proposals.length >= args.maxProposals) break;
    proposals.push(candidate);
  }

  if (staleCaseSignal && staleCaseSignal.count > 0) {
    if (proposals.length >= args.maxProposals) {
      return proposals.slice(0, args.maxProposals);
    }
    proposals.push({
      source: "planner_seed_case_stale",
      title: "滞留案件の情報回収を実施",
      rationale: `${staleCaseSignal.count}件のopen案件が長時間更新されていないため、未回収情報と担当状況の確認を先行します。`,
      summary: "滞留案件に対して不足情報の回収と次アクション期限の明確化を促す連絡案です。",
      proposed_actions: [
        {
          provider: "google",
          action_type: "send_email",
          to: `ops@${domain}`,
          subject: `【要対応】滞留案件の更新確認（${staleCaseSignal.count}件）`,
          body_text: `以下の案件で更新が滞留しています。状況確認と次アクション予定日を返信してください。\n\n${staleCaseTitles.length > 0 ? staleCaseTitles.map((title, idx) => `${idx + 1}. ${title}`).join("\n") : "・案件一覧はAI Agent OSの案件台帳を参照"}\n\n回答期限: 本日中`
        }
      ],
      risks: ["送信前に宛先グループが最新か確認してください。"]
    });
  }

  if (proposals.length < args.maxProposals) {
    proposals.push(
      ...makeStubProposals({
        signals: args.signals,
        maxProposals: args.maxProposals - proposals.length
      })
    );
  }

  return proposals.slice(0, args.maxProposals);
}

function proposalFingerprint(proposal: PlannerProposal) {
  const action = proposal.proposed_actions[0];
  return `${proposal.title}|${action?.to ?? ""}|${action?.subject ?? ""}`;
}

function normalizeForKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function plannerProposalKey(proposal: {
  title: string;
  proposed_actions: Array<{ to: string; subject: string; body_text: string }>;
}) {
  const first = proposal.proposed_actions[0];
  return [
    normalizeForKey(proposal.title),
    normalizeForKey(first?.to ?? ""),
    normalizeForKey(first?.subject ?? ""),
    normalizeForKey(first?.body_text ?? "")
  ].join("|");
}

function extractExistingProposalKey(row: { title?: string | null; proposed_actions_json?: unknown }) {
  const title = typeof row.title === "string" ? row.title : "";
  const proposedRaw = Array.isArray(row.proposed_actions_json) ? row.proposed_actions_json : [];
  const first = proposedRaw[0];
  if (typeof first !== "object" || first === null) {
    return plannerProposalKey({ title, proposed_actions: [] });
  }
  const firstObj = first as Record<string, unknown>;
  return plannerProposalKey({
    title,
    proposed_actions: [
      {
        to: typeof firstObj.to === "string" ? firstObj.to : "",
        subject: typeof firstObj.subject === "string" ? firstObj.subject : "",
        body_text: typeof firstObj.body_text === "string" ? firstObj.body_text : ""
      }
    ]
  });
}

function mergeProposals(seed: PlannerProposal[], generated: PlannerProposal[], maxProposals: number) {
  const merged: PlannerProposal[] = [];
  const seen = new Set<string>();
  for (const row of [...seed, ...generated]) {
    const key = proposalFingerprint(row);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
    if (merged.length >= maxProposals) break;
  }
  return merged;
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
    policy_warn_block: 5,
    stale_open_cases: 7,
    new_inbound_events: 3
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
  externalTemplateFeedback: ExternalTemplateFeedback;
}): Promise<PlannerProposal[]> {
  const seedProposals = makeSeedProposals({
    signals: args.signals,
    maxProposals: args.maxProposals,
    externalTemplateFeedback: args.externalTemplateFeedback
  });
  if (seedProposals.length >= args.maxProposals) {
    return seedProposals.slice(0, args.maxProposals);
  }

  if (process.env.E2E_MODE === "1") {
    return seedProposals.slice(0, args.maxProposals);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return seedProposals.slice(0, args.maxProposals);
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const domain = getAllowedDomainForProposal();
  const staleCaseSignal = args.signals.find((signal) => signal.kind === "stale_open_cases");
  const staleCaseTitles = pickSampleCaseTitles(staleCaseSignal);
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
    `stale_case_titles=${JSON.stringify(staleCaseTitles)}`,
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
    return seedProposals.slice(0, args.maxProposals);
  }
  return mergeProposals(seedProposals, normalized, args.maxProposals);
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
  const runtime = await getOpsRuntimeSettings({ supabase, orgId });

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
    const signals = await buildSignals({
      supabase,
      orgId,
      staleHours: runtime.monitorStaleHours
    });
    const feedback = await buildProposalFeedback({
      supabase,
      orgId,
      requestedMaxProposals: maxProposals
    });
    const externalTemplateFeedback = await buildExternalTemplateFeedback({
      supabase,
      orgId
    });
    const proposals = await generateProposalsWithOpenAI({
      signals,
      maxProposals: feedback.effectiveMaxProposals,
      feedback,
      externalTemplateFeedback
    });

    const dedupeHours = runtime.plannerProposalDedupeHours;
    const dedupeSinceIso = new Date(Date.now() - dedupeHours * 60 * 60 * 1000).toISOString();
    const existingProposalKeySet = new Set<string>();
    const { data: recentProposals, error: recentProposalsError } = await supabase
      .from("task_proposals")
      .select("id, title, proposed_actions_json, status, created_at")
      .eq("org_id", orgId)
      .gte("created_at", dedupeSinceIso)
      .in("status", ["proposed", "accepted", "executed"])
      .order("created_at", { ascending: false })
      .limit(500);
    if (recentProposalsError) {
      throw new Error(`proposal dedupe query failed: ${recentProposalsError.message}`);
    }
    for (const row of recentProposals ?? []) {
      existingProposalKeySet.add(
        extractExistingProposalKey({
          title: (row.title as string | null) ?? "",
          proposed_actions_json: row.proposed_actions_json
        })
      );
    }

    let createdCount = 0;
    let duplicateSkippedCount = 0;
    for (const proposal of proposals) {
      const proposalKey = plannerProposalKey({
        title: proposal.title,
        proposed_actions: proposal.proposed_actions.map((action) => ({
          to: action.to,
          subject: action.subject,
          body_text: action.body_text
        }))
      });
      if (existingProposalKeySet.has(proposalKey)) {
        duplicateSkippedCount += 1;
        await appendProposalEvent({
          supabase,
          orgId,
          proposalId: null,
          eventType: "PROPOSAL_SKIPPED_DUPLICATE",
          payload: {
            planner_run_id: plannerRunId,
            dedupe_hours: dedupeHours,
            source: proposal.source,
            title: proposal.title
          }
        });
        continue;
      }

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
      existingProposalKeySet.add(proposalKey);
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
      duplicate_skipped: duplicateSkippedCount,
      dedupe_hours: dedupeHours,
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
      external_template_feedback: externalTemplateFeedback,
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
