import type { SupabaseClient } from "@supabase/supabase-js";
import { getGovernanceSettings } from "@/lib/governance/evaluate";

export type RecommendationPriority = "critical" | "high" | "medium" | "low";

export type GovernanceRecommendation = {
  id: string;
  priority: RecommendationPriority;
  title: string;
  description: string;
  metricLabel: string;
  metricValue: string;
  actionLabel: string;
  href: string;
  automation:
    | {
        kind: "disable_auto_execute" | "send_approval_reminder";
        label: string;
      }
    | null;
};

export type GovernanceRecommendationSummary = {
  openIncidents: number;
  staleApprovals24h: number;
  staleApprovals72h: number;
  approvalBlockedEvents7d: number;
  sodBlockedEvents7d: number;
  failedActions7d: number;
  failedChatCommands7d: number;
  pendingChatConfirmations: number;
  overdueChatConfirmations: number;
  successActions7d: number;
  actionSuccessRate7d: number | null;
  policyBlockEvents7d: number;
  lowTrustSnapshots: number;
  budgetRemaining: number | null;
  budgetLimit: number;
  autoExecuteGoogleSendEmail: boolean;
};

function toPriorityRank(priority: RecommendationPriority) {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "medium") return 2;
  return 3;
}

function formatPercent(value: number | null) {
  if (value === null) return "-";
  return `${value}%`;
}

export async function buildGovernanceRecommendations(args: {
  supabase: SupabaseClient;
  orgId: string;
  windowHours?: number;
}) {
  const { supabase, orgId } = args;
  const windowHours =
    typeof args.windowHours === "number" && Number.isFinite(args.windowHours)
      ? Math.max(24, Math.min(24 * 30, Math.round(args.windowHours)))
      : 24 * 7;
  const settings = await getGovernanceSettings({ supabase, orgId });
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const sinceWindowIso = new Date(now - windowHours * 60 * 60 * 1000).toISOString();
  const windowParam = windowHours <= 24 ? "24h" : windowHours >= 24 * 30 ? "30d" : "7d";
  const withWindow = (href: string) => `${href}${href.includes("?") ? "&" : "?"}window=${windowParam}`;
  const before24h = new Date(now - dayMs).toISOString();
  const before72h = new Date(now - 3 * dayMs).toISOString();

  const [
    incidentsRes,
    approvals24Res,
    approvals72Res,
    actionsRes,
    approvalBlockedRes,
    sodBlockedRes,
    approvalBlockedRowsRes,
    policyBlocksRes,
    lowTrustRes,
    budgetUsageRes,
    failedChatCommandsRes,
    pendingChatConfirmationsRes,
    overdueChatConfirmationsRes
  ] =
    await Promise.all([
      supabase
        .from("org_incidents")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("status", "open"),
      supabase
        .from("approvals")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("status", "pending")
        .lt("created_at", before24h),
      supabase
        .from("approvals")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("status", "pending")
        .lt("created_at", before72h),
      supabase
        .from("actions")
        .select("status")
        .eq("org_id", orgId)
        .gte("created_at", sinceWindowIso)
        .in("status", ["success", "failed"])
        .limit(2000),
      supabase
        .from("task_events")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("event_type", "APPROVAL_BLOCKED")
        .gte("created_at", sinceWindowIso),
      supabase
        .from("task_events")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("event_type", "APPROVAL_BLOCKED")
        .gte("created_at", sinceWindowIso)
        .filter("payload_json->>reason_code", "eq", "sod_initiator_approver_conflict"),
      supabase
        .from("task_events")
        .select("actor_id, payload_json")
        .eq("org_id", orgId)
        .eq("event_type", "APPROVAL_BLOCKED")
        .gte("created_at", sinceWindowIso)
        .limit(2000),
      supabase
        .from("task_events")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("event_type", "POLICY_CHECKED")
        .gte("created_at", sinceWindowIso)
        .filter("payload_json->>status", "eq", "block"),
      supabase
        .from("trust_scores")
        .select("score")
        .eq("org_id", orgId)
        .lt("score", settings.minTrustScore)
        .gte("updated_at", sinceWindowIso)
        .limit(500),
      supabase
        .from("budget_usage")
        .select("used_count")
        .eq("org_id", orgId)
        .eq("provider", "google")
        .eq("action_type", "send_email")
        .eq("usage_date", new Date().toISOString().slice(0, 10))
        .maybeSingle(),
      supabase
        .from("chat_commands")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("execution_status", "failed")
        .gte("created_at", sinceWindowIso),
      supabase
        .from("chat_confirmations")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("status", "pending"),
      supabase
        .from("chat_confirmations")
        .select("id", { head: true, count: "exact" })
        .eq("org_id", orgId)
        .eq("status", "pending")
        .lt("expires_at", new Date().toISOString())
    ]);

  const missingTable = (message: string, table: string) =>
    message.includes(`relation "${table}" does not exist`) || message.includes(`public.${table}`);

  if (incidentsRes.error && !missingTable(incidentsRes.error.message, "org_incidents")) {
    throw new Error(`incident metrics query failed: ${incidentsRes.error.message}`);
  }
  if (approvals24Res.error) {
    throw new Error(`approval stale query failed: ${approvals24Res.error.message}`);
  }
  if (approvals72Res.error) {
    throw new Error(`approval stale query failed: ${approvals72Res.error.message}`);
  }
  if (actionsRes.error) {
    throw new Error(`action metrics query failed: ${actionsRes.error.message}`);
  }
  if (approvalBlockedRes.error && !missingTable(approvalBlockedRes.error.message, "task_events")) {
    throw new Error(`approval blocked metrics query failed: ${approvalBlockedRes.error.message}`);
  }
  if (sodBlockedRes.error && !missingTable(sodBlockedRes.error.message, "task_events")) {
    throw new Error(`sod blocked metrics query failed: ${sodBlockedRes.error.message}`);
  }
  if (approvalBlockedRowsRes.error && !missingTable(approvalBlockedRowsRes.error.message, "task_events")) {
    throw new Error(`approval blocked detail query failed: ${approvalBlockedRowsRes.error.message}`);
  }
  if (
    policyBlocksRes.error &&
    !missingTable(policyBlocksRes.error.message, "task_events") &&
    !policyBlocksRes.error.message.includes("payload_json")
  ) {
    throw new Error(`policy block metrics query failed: ${policyBlocksRes.error.message}`);
  }
  if (lowTrustRes.error && !missingTable(lowTrustRes.error.message, "trust_scores")) {
    throw new Error(`trust metrics query failed: ${lowTrustRes.error.message}`);
  }
  if (budgetUsageRes.error && !missingTable(budgetUsageRes.error.message, "budget_usage")) {
    throw new Error(`budget metrics query failed: ${budgetUsageRes.error.message}`);
  }
  if (failedChatCommandsRes.error && !missingTable(failedChatCommandsRes.error.message, "chat_commands")) {
    throw new Error(`chat command metrics query failed: ${failedChatCommandsRes.error.message}`);
  }
  if (
    pendingChatConfirmationsRes.error &&
    !missingTable(pendingChatConfirmationsRes.error.message, "chat_confirmations")
  ) {
    throw new Error(`chat confirmation metrics query failed: ${pendingChatConfirmationsRes.error.message}`);
  }
  if (
    overdueChatConfirmationsRes.error &&
    !missingTable(overdueChatConfirmationsRes.error.message, "chat_confirmations")
  ) {
    throw new Error(`chat overdue confirmation metrics query failed: ${overdueChatConfirmationsRes.error.message}`);
  }

  const actions = actionsRes.data ?? [];
  const successActions7d = actions.filter((row) => row.status === "success").length;
  const failedActions7d = actions.filter((row) => row.status === "failed").length;
  const totalActions7d = successActions7d + failedActions7d;
  const actionSuccessRate7d =
    totalActions7d > 0 ? Math.round((successActions7d / totalActions7d) * 100) : null;
  const budgetUsed = (budgetUsageRes.data?.used_count as number | undefined) ?? 0;
  const budgetRemaining = Math.max(0, settings.dailySendEmailLimit - budgetUsed);
  const approvalBlockedRows = (approvalBlockedRowsRes.data ?? []) as Array<{
    actor_id: string | null;
    payload_json: unknown;
  }>;
  const sodBlockedRows = approvalBlockedRows.filter((row) => {
    if (typeof row.payload_json !== "object" || row.payload_json === null) return false;
    const payload = row.payload_json as Record<string, unknown>;
    return payload.reason_code === "sod_initiator_approver_conflict";
  });
  const sodSourceCounts = new Map<string, number>();
  const sodActorCounts = new Map<string, number>();
  for (const row of sodBlockedRows) {
    const payload = row.payload_json as Record<string, unknown>;
    const source = typeof payload.source === "string" && payload.source.length > 0 ? payload.source : "unknown";
    sodSourceCounts.set(source, (sodSourceCounts.get(source) ?? 0) + 1);
    if (row.actor_id) {
      sodActorCounts.set(row.actor_id, (sodActorCounts.get(row.actor_id) ?? 0) + 1);
    }
  }
  const topSodSource = Array.from(sodSourceCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
  const topSodActorEntry = Array.from(sodActorCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
  let topSodActorLabel = topSodActorEntry?.[0] ?? null;
  if (topSodActorEntry?.[0]) {
    const actorId = topSodActorEntry[0];
    const profileRes = await supabase
      .from("user_profiles")
      .select("display_name")
      .eq("org_id", orgId)
      .eq("user_id", actorId)
      .maybeSingle();
    if (
      profileRes.error &&
      !missingTable(profileRes.error.message, "user_profiles")
    ) {
      throw new Error(`user profile query failed: ${profileRes.error.message}`);
    }
    const displayName = (profileRes.data?.display_name as string | null | undefined) ?? null;
    if (displayName && displayName.trim().length > 0) {
      topSodActorLabel = displayName.trim();
    }
  }

  const summary: GovernanceRecommendationSummary = {
    openIncidents: incidentsRes.count ?? 0,
    staleApprovals24h: approvals24Res.count ?? 0,
    staleApprovals72h: approvals72Res.count ?? 0,
    approvalBlockedEvents7d: approvalBlockedRes.count ?? 0,
    sodBlockedEvents7d: sodBlockedRes.count ?? 0,
    failedActions7d,
    failedChatCommands7d: failedChatCommandsRes.count ?? 0,
    pendingChatConfirmations: pendingChatConfirmationsRes.count ?? 0,
    overdueChatConfirmations: overdueChatConfirmationsRes.count ?? 0,
    successActions7d,
    actionSuccessRate7d,
    policyBlockEvents7d: policyBlocksRes.count ?? 0,
    lowTrustSnapshots: (lowTrustRes.data ?? []).length,
    budgetRemaining,
    budgetLimit: settings.dailySendEmailLimit,
    autoExecuteGoogleSendEmail: settings.autoExecuteGoogleSendEmail
  };

  const recommendations: GovernanceRecommendation[] = [];

  if (summary.openIncidents > 0) {
    recommendations.push({
      id: "incident-open",
      priority: "critical",
      title: "インシデントを最優先で解消",
      description:
        "オープン中のインシデントがあるため、自律実行は停止されています。原因を特定し、復旧確認後に解決してください。",
      metricLabel: "open incidents",
      metricValue: String(summary.openIncidents),
      actionLabel: "インシデント管理へ",
      href: withWindow("/app/governance/incidents"),
      automation: null
    });
  }

  if (summary.staleApprovals72h > 0) {
    recommendations.push({
      id: "approvals-stale-72h",
      priority: "high",
      title: "72時間超の承認滞留を解消",
      description:
        "長時間の承認滞留は業務停止に直結します。承認担当の再割当てか通知ルート強化を実施してください。",
      metricLabel: "pending >72h",
      metricValue: String(summary.staleApprovals72h),
      actionLabel: "承認キューを確認",
      href: withWindow("/app/approvals"),
      automation: { kind: "send_approval_reminder", label: "Slackで承認催促を送信" }
    });
  } else if (summary.staleApprovals24h > 0) {
    recommendations.push({
      id: "approvals-stale-24h",
      priority: "medium",
      title: "承認滞留（24時間超）を圧縮",
      description: "承認待ちの先行処理でリードタイムを短縮できます。優先度の高い案件から処理してください。",
      metricLabel: "pending >24h",
      metricValue: String(summary.staleApprovals24h),
      actionLabel: "承認キューを確認",
      href: withWindow("/app/approvals"),
      automation: { kind: "send_approval_reminder", label: "Slackで承認催促を送信" }
    });
  }

  if (summary.sodBlockedEvents7d > 0) {
    const sourceText = topSodSource ? `${topSodSource[0]}(${topSodSource[1]}件)` : "unknown";
    const actorText = topSodActorLabel && topSodActorEntry ? `${topSodActorLabel}(${topSodActorEntry[1]}件)` : "特定なし";
    recommendations.push({
      id: "approvals-sod-blocked",
      priority: "high",
      title: "職務分掌違反の承認試行を是正",
      description:
        `起票者自身による承認試行が検知されています。最多経路=${sourceText} / 最多起点=${actorText}。承認者アサインと操作手順を見直し、再発を防止してください。`,
      metricLabel: "sod blocked approvals (7d)",
      metricValue: String(summary.sodBlockedEvents7d),
      actionLabel: "ブロック承認を確認",
      href: withWindow("/app/approvals?blocked_only=1"),
      automation: null
    });
  } else if (summary.approvalBlockedEvents7d > 0) {
    recommendations.push({
      id: "approvals-blocked",
      priority: "medium",
      title: "承認ブロック要因を解消",
      description:
        "承認ブロックイベントが発生しています。ブロック理由を確認し、ルールや運用導線を調整してください。",
      metricLabel: "blocked approvals (7d)",
      metricValue: String(summary.approvalBlockedEvents7d),
      actionLabel: "ブロック承認を確認",
      href: withWindow("/app/approvals?blocked_only=1"),
      automation: null
    });
  }

  if (summary.failedActions7d >= 3) {
    recommendations.push({
      id: "action-failure-burst",
      priority: "high",
      title: "実行失敗率を改善",
      description:
        "送信実行の失敗が増加しています。Google接続状態、宛先ドメイン制約、ワークフロー入力品質を確認してください。",
      metricLabel: "failed actions (7d)",
      metricValue: String(summary.failedActions7d),
      actionLabel: "タスク実行ログを確認",
      href: withWindow("/app/tasks"),
      automation: summary.autoExecuteGoogleSendEmail
        ? { kind: "disable_auto_execute", label: "自動実行を一時停止" }
        : null
    });
  } else if (summary.actionSuccessRate7d !== null && summary.actionSuccessRate7d < 85) {
    recommendations.push({
      id: "action-success-rate-low",
      priority: "medium",
      title: "送信成功率を引き上げ",
      description:
        "成功率が低下しています。失敗ログを分析し、テンプレートとガードレールを調整してください。",
      metricLabel: "success rate (7d)",
      metricValue: formatPercent(summary.actionSuccessRate7d),
      actionLabel: "証跡を確認",
      href: withWindow("/app/tasks"),
      automation: null
    });
  }

  if (summary.overdueChatConfirmations > 0) {
    recommendations.push({
      id: "chat-confirmation-overdue",
      priority: "high",
      title: "チャット確認キューの期限切れを解消",
      description:
        "期限切れの確認待ちが残っています。確認キューを整理し、失敗コマンドの再実行または取り下げを進めてください。",
      metricLabel: "overdue chat confirmations",
      metricValue: String(summary.overdueChatConfirmations),
      actionLabel: "チャット監査ログへ",
      href: withWindow("/app/chat/audit?status=pending"),
      automation: null
    });
  } else if (summary.pendingChatConfirmations >= 10) {
    recommendations.push({
      id: "chat-confirmation-backlog",
      priority: "medium",
      title: "チャット確認待ちの滞留を圧縮",
      description:
        "確認待ちが増えています。高優先の確認から処理し、不要な依頼は取り下げてキューを軽量化してください。",
      metricLabel: "pending chat confirmations",
      metricValue: String(summary.pendingChatConfirmations),
      actionLabel: "チャット監査ログへ",
      href: withWindow("/app/chat/audit?status=pending"),
      automation: null
    });
  }

  if (summary.failedChatCommands7d >= 5) {
    recommendations.push({
      id: "chat-command-failures",
      priority: "medium",
      title: "チャット実行失敗を改善",
      description:
        "チャット起点の実行失敗が増加しています。対象解決の曖昧性や権限/上限制約の失敗要因を確認してください。",
      metricLabel: "failed chat commands (7d)",
      metricValue: String(summary.failedChatCommands7d),
      actionLabel: "チャット監査ログへ",
      href: withWindow("/app/chat/audit?status=failed"),
      automation: null
    });
  }

  if (summary.lowTrustSnapshots > 0) {
    recommendations.push({
      id: "trust-low",
      priority: "high",
      title: "信頼スコア低下を修正",
      description:
        "最小信頼スコアを下回る履歴があります。失敗要因を特定し、必要なら自律レベルと閾値を見直してください。",
      metricLabel: "low trust rows (7d)",
      metricValue: String(summary.lowTrustSnapshots),
      actionLabel: "信頼分析へ",
      href: withWindow("/app/governance/trust"),
      automation: summary.autoExecuteGoogleSendEmail
        ? { kind: "disable_auto_execute", label: "自動実行を一時停止" }
        : null
    });
  }

  if (summary.policyBlockEvents7d > 0) {
    recommendations.push({
      id: "policy-blocks",
      priority: "medium",
      title: "ポリシーブロック要因の事前除去",
      description:
        "ブロック判定が発生しています。宛先ドメイン許可リストや入力テンプレートを改善して再発を防いでください。",
      metricLabel: "policy blocks (7d)",
      metricValue: String(summary.policyBlockEvents7d),
      actionLabel: "ポリシー影響タスクを見る",
      href: withWindow("/app/tasks"),
      automation: null
    });
  }

  if (summary.budgetRemaining !== null && summary.budgetRemaining <= Math.max(1, Math.floor(summary.budgetLimit * 0.1))) {
    recommendations.push({
      id: "budget-near-limit",
      priority: "medium",
      title: "日次予算上限に接近",
      description:
        "メール送信予算の残量が少なく、後続ジョブが詰まる可能性があります。必要なら上限を調整してください。",
      metricLabel: "daily remaining",
      metricValue: `${summary.budgetRemaining}/${summary.budgetLimit}`,
      actionLabel: "予算設定へ",
      href: withWindow("/app/governance/budgets"),
      automation: null
    });
  }

  if (summary.autoExecuteGoogleSendEmail) {
    recommendations.push({
      id: "auto-execute-enabled-checkpoint",
      priority: "medium",
      title: "自動実行トグルの定期見直し",
      description:
        "Google send_email の自動実行が有効です。障害対応や運用変更時には一時停止して手動承認へ戻せます。",
      metricLabel: "auto execute",
      metricValue: "enabled",
      actionLabel: "自律設定を確認",
      href: withWindow("/app/governance/autonomy"),
      automation: { kind: "disable_auto_execute", label: "自動実行を一時停止" }
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      id: "healthy",
      priority: "low",
      title: "主要ガードレールは安定",
      description:
        "現時点で重大な改善シグナルは検知されていません。提案・承認・実行のリードタイム最適化を継続してください。",
      metricLabel: "health",
      metricValue: "stable",
      actionLabel: "プランナーへ",
      href: withWindow("/app/planner"),
      automation: null
    });
  }

  recommendations.sort((a, b) => toPriorityRank(a.priority) - toPriorityRank(b.priority));
  return { summary, recommendations, settings };
}
