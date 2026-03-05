import Link from "next/link";
import { bulkRetryFailedCommands } from "@/app/app/chat/actions";
import { buildGovernanceRecommendations } from "@/lib/governance/recommendations";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

const links = [
  {
    title: "エージェント",
    href: "/app/agents",
    description: "接続先ごとの実行を担当するエージェントを管理します。"
  },
  {
    title: "タスク",
    href: "/app/tasks",
    description: "受け付けたタスクと処理ステータスを確認します。"
  },
  {
    title: "承認",
    href: "/app/approvals",
    description: "保留中の承認と最近の判断結果を確認します。"
  },
  {
    title: "提案",
    href: "/app/proposals",
    description: "自律提案を確認し、実タスクに変換します。"
  },
  {
    title: "プランナー",
    href: "/app/planner",
    description: "プランナー実行と結果サマリーを確認します。"
  },
  {
    title: "ワークフロー",
    href: "/app/workflows",
    description: "テンプレートと実行ステップを管理します。"
  },
  {
    title: "共有チャット",
    href: "/app/chat/shared",
    description: "組織全体向けの会話で、タスク依頼や状況確認を実行確認付きで行います。"
  },
  {
    title: "個人チャット",
    href: "/app/chat/me",
    description: "個人向けの質問や依頼を、UI操作なしで会話から実行できます。"
  },
  {
    title: "チャット監査",
    href: "/app/chat/audit",
    description: "チャット起点コマンドの実行結果を横断確認し、失敗トリアージします。"
  },
  {
    title: "ジョブ履歴",
    href: "/app/operations/jobs",
    description: "定期実行ジョブ（planner/review）の成功・失敗を監視します。"
  },
  {
    title: "例外キュー",
    href: "/app/operations/exceptions",
    description: "失敗アクション、失敗ワークフロー、承認滞留を集中トリアージします。"
  },
  {
    title: "自律設定",
    href: "/app/governance/autonomy",
    description: "自律レベル、リスク閾値、Trust閾値を組織単位で設定します。"
  },
  {
    title: "改善提案",
    href: "/app/governance/recommendations",
    description: "運用データから優先度付きの改善アクションを提示します。"
  },
  {
    title: "予算",
    href: "/app/governance/budgets",
    description: "コネクタ実行の利用上限と日次使用量を確認します。"
  },
  {
    title: "Trust",
    href: "/app/governance/trust",
    description: "実行結果と承認却下から算出される信頼スコアを確認します。"
  },
  {
    title: "インシデント",
    href: "/app/governance/incidents",
    description: "障害時に自動実行を緊急停止し、復旧後に解除します。"
  }
];

function statusColor(status: string) {
  if (status === "failed") return "bg-rose-500";
  if (status === "ready_for_approval") return "bg-amber-500";
  if (status === "approved") return "bg-sky-500";
  if (status === "done") return "bg-emerald-500";
  if (status === "executing") return "bg-indigo-500";
  return "bg-slate-500";
}

function consecutiveFailuresByStatus(rows: Array<{ status: string | null }>) {
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

function consecutiveFailuresByEvent(rows: Array<{ event_type: string | null }>, failedType: string) {
  let count = 0;
  for (const row of rows) {
    if (row.event_type === failedType) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function skipRecommendation(reason: string | null) {
  if (reason === "approval_not_pending") {
    return {
      text: "承認待ちの先行解消が多発。承認キューを先に確認。",
      href: "/app/chat/audit?skip_reason=approval_not_pending",
      severity: "medium" as const
    };
  }
  if (reason === "approval_already_pending") {
    return {
      text: "重複依頼が多発。既存pending優先に運用統一。",
      href: "/app/chat/audit?skip_reason=approval_already_pending",
      severity: "low" as const
    };
  }
  if (reason === "stale_top_candidates") {
    return {
      text: "TOP候補が陳腐化。先に状況確認を再実行。",
      href: "/app/chat/audit?skip_reason=stale_top_candidates",
      severity: "high" as const
    };
  }
  return { text: "skip要因を監査画面で確認。", href: "/app/chat/audit", severity: "low" as const };
}

export default async function AppHomePage() {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleApprovalHours = Number(process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6");
  const staleApprovalCutoffIso = new Date(Date.now() - staleApprovalHours * 60 * 60 * 1000).toISOString();
  const [
    tasksRes,
    approvalsRes,
    actionsRes,
    incidentsRes,
    recommendationPack,
    plannerRunsRes,
    reviewEventsRes,
    proposalsRes,
    chatCommandsRes,
    chatIntentsRes
  ] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("approvals")
      .select("id, status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("actions")
      .select("id, status, created_at")
      .eq("org_id", orgId)
      .gte("created_at", sevenDaysAgoIso)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("org_incidents").select("id, status").eq("org_id", orgId).eq("status", "open").limit(20),
    buildGovernanceRecommendations({ supabase, orgId }),
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
      .from("task_proposals")
      .select("id, status, policy_status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("chat_commands")
      .select("id, intent_id, execution_status, created_at, result_json")
      .eq("org_id", orgId)
      .gte("created_at", sevenDaysAgoIso)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("chat_intents")
      .select("id, intent_type, created_at")
      .eq("org_id", orgId)
      .gte("created_at", sevenDaysAgoIso)
      .order("created_at", { ascending: false })
      .limit(1000)
  ]);

  if (tasksRes.error) {
    throw new Error(`Failed to load task metrics: ${tasksRes.error.message}`);
  }
  if (approvalsRes.error) {
    throw new Error(`Failed to load approval metrics: ${approvalsRes.error.message}`);
  }
  if (actionsRes.error) {
    throw new Error(`Failed to load action metrics: ${actionsRes.error.message}`);
  }
  if (
    incidentsRes.error &&
    !incidentsRes.error.message.includes('relation "org_incidents" does not exist') &&
    !incidentsRes.error.message.includes("Could not find the table 'public.org_incidents'")
  ) {
    throw new Error(`Failed to load incident metrics: ${incidentsRes.error.message}`);
  }
  if (
    plannerRunsRes.error &&
    !plannerRunsRes.error.message.includes('relation "planner_runs" does not exist') &&
    !plannerRunsRes.error.message.includes("Could not find the table 'public.planner_runs'")
  ) {
    throw new Error(`Failed to load planner run metrics: ${plannerRunsRes.error.message}`);
  }
  if (reviewEventsRes.error) {
    throw new Error(`Failed to load governance review metrics: ${reviewEventsRes.error.message}`);
  }
  if (
    proposalsRes.error &&
    !proposalsRes.error.message.includes('relation "task_proposals" does not exist') &&
    !proposalsRes.error.message.includes("Could not find the table 'public.task_proposals'")
  ) {
    throw new Error(`Failed to load proposal metrics: ${proposalsRes.error.message}`);
  }
  if (
    chatCommandsRes.error &&
    !chatCommandsRes.error.message.includes('relation "chat_commands" does not exist') &&
    !chatCommandsRes.error.message.includes("Could not find the table 'public.chat_commands'")
  ) {
    throw new Error(`Failed to load chat command metrics: ${chatCommandsRes.error.message}`);
  }
  if (
    chatIntentsRes.error &&
    !chatIntentsRes.error.message.includes('relation "chat_intents" does not exist') &&
    !chatIntentsRes.error.message.includes("Could not find the table 'public.chat_intents'")
  ) {
    throw new Error(`Failed to load chat intent metrics: ${chatIntentsRes.error.message}`);
  }

  const tasks = tasksRes.data ?? [];
  const approvals = approvalsRes.data ?? [];
  const actions = actionsRes.data ?? [];
  const openIncidents = incidentsRes.data ?? [];
  const plannerRuns = plannerRunsRes.data ?? [];
  const reviewEvents = reviewEventsRes.data ?? [];
  const proposals = proposalsRes.data ?? [];
  const chatCommands = chatCommandsRes.data ?? [];
  const chatIntents = chatIntentsRes.data ?? [];

  const taskStatusOrder = ["draft", "ready_for_approval", "approved", "executing", "done", "failed"];
  const taskStatusCounts = new Map<string, number>();
  for (const task of tasks) {
    const key = String(task.status ?? "unknown");
    taskStatusCounts.set(key, (taskStatusCounts.get(key) ?? 0) + 1);
  }

  const maxTaskCount = Math.max(1, ...Array.from(taskStatusCounts.values()));
  const pendingApprovals = approvals.filter((row) => row.status === "pending").length;
  const stalePendingApprovals = approvals.filter(
    (row) => row.status === "pending" && typeof row.created_at === "string" && row.created_at < staleApprovalCutoffIso
  ).length;
  const rejectedApprovals = approvals.filter((row) => row.status === "rejected").length;
  const executedActions = actions.filter((row) => row.status === "success").length;
  const failedActions = actions.filter((row) => row.status === "failed").length;
  const failedActions24h = actions.filter(
    (row) =>
      row.status === "failed" &&
      typeof row.created_at === "string" &&
      row.created_at >= new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  ).length;
  const blockedProposals = proposals.filter((row) => row.policy_status === "block" && row.status === "proposed").length;
  const pendingProposals = proposals.filter((row) => row.status === "proposed").length;
  const failedChatCommands = chatCommands.filter((row) => row.execution_status === "failed").length;
  const runningChatCommands = chatCommands.filter((row) => row.execution_status === "running").length;
  const skippedChatCommands = chatCommands.filter((row) => asObject(row.result_json)?.skipped === true).length;
  const skipReasonCounts = new Map<string, number>();
  for (const row of chatCommands) {
    const result = asObject(row.result_json);
    if (!result || result.skipped !== true) continue;
    const reason = typeof result.skip_reason === "string" && result.skip_reason.length > 0 ? result.skip_reason : "unknown";
    skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);
  }
  const topSkipReasonEntry = Array.from(skipReasonCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
  const topSkipReason = topSkipReasonEntry?.[0] ?? null;
  const topSkipReasonCount = topSkipReasonEntry?.[1] ?? 0;
  const skipReco = skipRecommendation(topSkipReason);
  const chatSkipHref = topSkipReason
    ? `/app/chat/audit?skip_reason=${encodeURIComponent(topSkipReason)}`
    : "/app/chat/audit";
  const intentTypeById = new Map(
    chatIntents.map((row) => [row.id as string, ((row.intent_type as string | null) ?? "unknown") as string])
  );
  const intentStats = Array.from(
    chatCommands
      .reduce((acc, row) => {
        const intentType = intentTypeById.get((row.intent_id as string) ?? "") ?? "unknown";
        const current = acc.get(intentType) ?? { intentType, total: 0, failed: 0 };
        current.total += 1;
        if (row.execution_status === "failed") current.failed += 1;
        acc.set(intentType, current);
        return acc;
      }, new Map<string, { intentType: string; total: number; failed: number }>())
      .values()
  ).map((row) => ({
    ...row,
    failureRate: row.total > 0 ? Math.round((row.failed / row.total) * 100) : 0
  }));
  const worstFailedIntent =
    intentStats
      .filter((row) => row.total >= 3 && row.failed > 0)
      .sort((a, b) => {
        if (b.failureRate !== a.failureRate) return b.failureRate - a.failureRate;
        if (b.failed !== a.failed) return b.failed - a.failed;
        return b.total - a.total;
      })[0] ?? null;
  const worstIntentHref = worstFailedIntent
    ? `/app/chat/audit?status=failed&intent=${encodeURIComponent(worstFailedIntent.intentType)}`
    : "/app/chat/audit?status=failed";
  const actionSuccessRate =
    executedActions + failedActions > 0
      ? Math.round((executedActions / (executedActions + failedActions)) * 100)
      : null;

  const urgentSignals = [
    openIncidents.length > 0 ? `インシデント ${openIncidents.length}件` : null,
    (taskStatusCounts.get("failed") ?? 0) > 0 ? `失敗タスク ${taskStatusCounts.get("failed") ?? 0}件` : null,
    pendingApprovals > 5 ? `承認待ち ${pendingApprovals}件` : null,
    failedActions > 0 ? `直近7日アクション失敗 ${failedActions}件` : null,
    failedChatCommands > 0 ? `直近7日チャット失敗 ${failedChatCommands}件` : null,
    worstFailedIntent && worstFailedIntent.failureRate >= 50
      ? `高失敗intent ${worstFailedIntent.intentType} (${worstFailedIntent.failureRate}%)`
      : null
  ].filter((v): v is string => Boolean(v));
  const criticalRecommendations = recommendationPack.recommendations.filter((item) => item.priority === "critical");
  const highRecommendations = recommendationPack.recommendations.filter((item) => item.priority === "high");
  const topRecommendations = recommendationPack.recommendations.slice(0, 3);
  const plannerConsecutiveFailures = consecutiveFailuresByStatus(
    plannerRuns.map((row) => ({ status: (row.status as string | null) ?? null }))
  );
  const reviewConsecutiveFailures = consecutiveFailuresByEvent(
    reviewEvents.map((row) => ({ event_type: (row.event_type as string | null) ?? null })),
    "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"
  );
  const needsOpsAttention = plannerConsecutiveFailures >= 2 || reviewConsecutiveFailures >= 2;
  const nextActions = [
    {
      key: "open_incidents",
      label: "オープンインシデントを確認",
      href: "/app/governance/incidents",
      score: openIncidents.length > 0 ? 100 + openIncidents.length * 5 : 0,
      detail: `open ${openIncidents.length}件`
    },
    {
      key: "failed_actions_24h",
      label: "失敗アクションをトリアージ",
      href: "/app/operations/exceptions",
      score: failedActions24h > 0 ? 85 + Math.min(15, failedActions24h) : 0,
      detail: `24h failed ${failedActions24h}件`
    },
    {
      key: "stale_approvals",
      label: "滞留承認を処理",
      href: "/app/approvals",
      score: stalePendingApprovals > 0 ? 80 + Math.min(20, stalePendingApprovals) : 0,
      detail: `${staleApprovalHours}h+ pending ${stalePendingApprovals}件`
    },
    {
      key: "blocked_proposals",
      label: "policy block提案を精査",
      href: "/app/proposals?status=proposed&policy_status=block",
      score: blockedProposals > 0 ? 70 + Math.min(20, blockedProposals) : 0,
      detail: `block proposals ${blockedProposals}件`
    },
    {
      key: "failed_chat_intent",
      label: "高失敗intentを復旧",
      href: worstIntentHref,
      score: worstFailedIntent ? Math.min(95, worstFailedIntent.failureRate) : 0,
      detail: worstFailedIntent
        ? `${worstFailedIntent.intentType} ${worstFailedIntent.failed}/${worstFailedIntent.total}`
        : "hotspot なし"
    },
    {
      key: "planner_failures",
      label: "ジョブ連続失敗を確認",
      href: "/app/operations/jobs?failed_only=1",
      score: needsOpsAttention ? 75 + Math.max(plannerConsecutiveFailures, reviewConsecutiveFailures) * 3 : 0,
      detail: `planner=${plannerConsecutiveFailures}, review=${reviewConsecutiveFailures}`
    }
  ]
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return (
    <section className="space-y-7">
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-teal-900 p-6 text-white shadow-lg">
        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-teal-200/90">Operations Console</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">AI Agent OS ワークスペース</h1>
            <p className="mt-3 text-sm text-slate-200/90">
              日次オペレーションの状態を一画面で確認し、異常や滞留があれば優先的に対処できます。
            </p>
            <p className="mt-4 inline-flex rounded-full border border-white/30 bg-white/10 px-3 py-1 text-xs text-slate-100">
              組織コンテキスト: {orgId}
            </p>
          </div>
          <div className="rounded-xl border border-white/20 bg-white/10 p-4 backdrop-blur">
            <p className="text-xs font-medium text-teal-100">緊急シグナル</p>
            {urgentSignals.length > 0 ? (
              <ul className="mt-3 space-y-2 text-sm">
                {urgentSignals.map((signal) => (
                  <li key={signal} className="rounded-md border border-rose-200/30 bg-rose-500/20 px-3 py-2 text-rose-100">
                    {signal}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-md border border-emerald-200/30 bg-emerald-500/20 px-3 py-2 text-sm text-emerald-100">
                緊急度の高いアラートはありません。
              </p>
            )}
          </div>
        </div>
      </section>

      {needsOpsAttention ? (
        <section className="rounded-xl border border-rose-300 bg-rose-50 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-rose-900">要対応: ジョブ連続失敗を検知</p>
              <p className="mt-1 text-xs text-rose-800">
                planner連続失敗 {plannerConsecutiveFailures}件 / review連続失敗 {reviewConsecutiveFailures}件
              </p>
            </div>
            <Link
              href="/app/operations/jobs?failed_only=1"
              className="rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-medium text-rose-800 hover:bg-rose-100"
            >
              失敗ジョブを確認
            </Link>
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-500">タスク総数</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{tasks.length}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <p className="text-xs text-amber-700">承認待ち</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{pendingApprovals}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-xs text-rose-700">却下数</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{rejectedApprovals}</p>
        </div>
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-4 shadow-sm">
          <p className="text-xs text-teal-700">7日成功率</p>
          <p className="mt-1 text-2xl font-semibold text-teal-900">{actionSuccessRate !== null ? `${actionSuccessRate}%` : "-"}</p>
        </div>
        <div className={`rounded-xl border p-4 shadow-sm ${openIncidents.length > 0 ? "border-rose-300 bg-rose-100" : "border-emerald-200 bg-emerald-50"}`}>
          <p className={`text-xs ${openIncidents.length > 0 ? "text-rose-700" : "text-emerald-700"}`}>オープンインシデント</p>
          <p className={`mt-1 text-2xl font-semibold ${openIncidents.length > 0 ? "text-rose-900" : "text-emerald-900"}`}>{openIncidents.length}</p>
        </div>
        <Link
          href="/app/governance/recommendations"
          className={`rounded-xl border p-4 shadow-sm ${
            criticalRecommendations.length > 0
              ? "border-rose-300 bg-rose-100"
              : highRecommendations.length > 0
                ? "border-amber-300 bg-amber-100"
                : "border-sky-200 bg-sky-50"
          }`}
        >
          <p
            className={`text-xs ${
              criticalRecommendations.length > 0
                ? "text-rose-700"
                : highRecommendations.length > 0
                  ? "text-amber-700"
                  : "text-sky-700"
            }`}
          >
            改善提案
          </p>
          <p
            className={`mt-1 text-2xl font-semibold ${
              criticalRecommendations.length > 0
                ? "text-rose-900"
                : highRecommendations.length > 0
                  ? "text-amber-900"
                  : "text-sky-900"
            }`}
          >
            C:{criticalRecommendations.length} / H:{highRecommendations.length}
          </p>
        </Link>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">優先対応キュー</h2>
          <span className="text-xs text-slate-500">緊急度の高いものを先頭表示</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          <Link
            href="/app/approvals"
            className={`rounded-lg border p-3 ${stalePendingApprovals > 0 ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className={`text-xs ${stalePendingApprovals > 0 ? "text-rose-700" : "text-slate-600"}`}>滞留承認 ({staleApprovalHours}h+)</p>
            <p className={`mt-1 text-xl font-semibold ${stalePendingApprovals > 0 ? "text-rose-900" : "text-slate-900"}`}>{stalePendingApprovals}</p>
          </Link>
          <Link
            href="/app/operations/exceptions"
            className={`rounded-lg border p-3 ${failedActions24h > 0 ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className={`text-xs ${failedActions24h > 0 ? "text-amber-700" : "text-slate-600"}`}>24h 失敗アクション</p>
            <p className={`mt-1 text-xl font-semibold ${failedActions24h > 0 ? "text-amber-900" : "text-slate-900"}`}>{failedActions24h}</p>
          </Link>
          <Link
            href="/app/proposals?status=proposed&policy_status=block"
            className={`rounded-lg border p-3 ${blockedProposals > 0 ? "border-fuchsia-300 bg-fuchsia-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className={`text-xs ${blockedProposals > 0 ? "text-fuchsia-700" : "text-slate-600"}`}>block 提案</p>
            <p className={`mt-1 text-xl font-semibold ${blockedProposals > 0 ? "text-fuchsia-900" : "text-slate-900"}`}>{blockedProposals}</p>
          </Link>
          <Link
            href="/app/proposals?status=proposed"
            className={`rounded-lg border p-3 ${pendingProposals > 0 ? "border-sky-300 bg-sky-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className={`text-xs ${pendingProposals > 0 ? "text-sky-700" : "text-slate-600"}`}>未判断提案</p>
            <p className={`mt-1 text-xl font-semibold ${pendingProposals > 0 ? "text-sky-900" : "text-slate-900"}`}>{pendingProposals}</p>
          </Link>
          <Link
            href="/app/chat/audit?status=failed"
            className={`rounded-lg border p-3 ${failedChatCommands > 0 ? "border-rose-300 bg-rose-50" : runningChatCommands > 0 ? "border-sky-300 bg-sky-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p
              className={`text-xs ${
                failedChatCommands > 0
                  ? "text-rose-700"
                  : runningChatCommands > 0
                    ? "text-sky-700"
                    : "text-slate-600"
              }`}
            >
              チャット失敗(7d)
            </p>
            <p
              className={`mt-1 text-xl font-semibold ${
                failedChatCommands > 0
                  ? "text-rose-900"
                  : runningChatCommands > 0
                    ? "text-sky-900"
                    : "text-slate-900"
              }`}
            >
              {failedChatCommands}
            </p>
          </Link>
          <Link
            href={chatSkipHref}
            className={`rounded-lg border p-3 ${
              skippedChatCommands > 0
                ? skipReco.severity === "high"
                  ? "border-rose-300 bg-rose-50"
                  : "border-amber-300 bg-amber-50"
                : "border-slate-200 bg-slate-50"
            }`}
          >
            <p className={`text-xs ${skippedChatCommands > 0 ? "text-amber-700" : "text-slate-600"}`}>チャット skip(7d)</p>
            <p className={`mt-1 text-xl font-semibold ${skippedChatCommands > 0 ? "text-amber-900" : "text-slate-900"}`}>{skippedChatCommands}</p>
            <p className="mt-1 text-[11px] text-slate-600">
              {topSkipReason ? `${topSkipReason} (${topSkipReasonCount})` : "主因なし"}
            </p>
          </Link>
          <Link
            href={worstIntentHref}
            className={`rounded-lg border p-3 ${
              worstFailedIntent && worstFailedIntent.failureRate >= 60
                ? "border-rose-300 bg-rose-50"
                : worstFailedIntent && worstFailedIntent.failureRate >= 30
                  ? "border-amber-300 bg-amber-50"
                  : "border-slate-200 bg-slate-50"
            }`}
          >
            <p
              className={`text-xs ${
                worstFailedIntent && worstFailedIntent.failureRate >= 60
                  ? "text-rose-700"
                  : worstFailedIntent && worstFailedIntent.failureRate >= 30
                    ? "text-amber-700"
                    : "text-slate-600"
              }`}
            >
              高失敗intent(7d)
            </p>
            <p
              className={`mt-1 text-xl font-semibold ${
                worstFailedIntent && worstFailedIntent.failureRate >= 60
                  ? "text-rose-900"
                  : worstFailedIntent && worstFailedIntent.failureRate >= 30
                    ? "text-amber-900"
                    : "text-slate-900"
              }`}
            >
              {worstFailedIntent ? `${worstFailedIntent.failureRate}%` : "-"}
            </p>
            <p className="mt-1 text-[11px] text-slate-600">
              {worstFailedIntent
                ? `${worstFailedIntent.intentType} (${worstFailedIntent.failed}/${worstFailedIntent.total})`
                : "主因なし"}
            </p>
          </Link>
        </div>
        {skippedChatCommands > 0 ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            チャット運用ヘルス: {skipReco.text}{" "}
            <Link href={skipReco.href} className="underline">
              対応する
            </Link>
          </div>
        ) : null}
        {worstFailedIntent && worstFailedIntent.failureRate >= 50 ? (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
            チャット失敗ホットスポット: {worstFailedIntent.intentType} の失敗率が {worstFailedIntent.failureRate}% です。{" "}
            <Link href={worstIntentHref} className="underline">
              failed一覧で優先対処
            </Link>
            <form action={bulkRetryFailedCommands} className="mt-2 flex flex-wrap items-center gap-2">
              <input type="hidden" name="return_to" value="/app" />
              <input type="hidden" name="scope" value="all" />
              <input type="hidden" name="intent_type" value={worstFailedIntent.intentType} />
              <input type="hidden" name="max_items" value="5" />
              <button
                type="submit"
                className="rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-800 hover:bg-rose-100"
              >
                このintentで再実行確認を一括作成（5件）
              </button>
            </form>
          </div>
        ) : null}
        {nextActions.length > 0 ? (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold text-slate-700">Next Actions (auto-sorted)</p>
            <ol className="mt-2 space-y-2">
              {nextActions.map((item, idx) => (
                <li key={item.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900 px-1 text-[10px] font-semibold text-white">
                      {idx + 1}
                    </span>
                    <span className="font-medium text-slate-900">{item.label}</span>
                    <span className="text-slate-500">{item.detail}</span>
                  </div>
                  <Link href={item.href} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100">
                    開く
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">AI改善提案（上位）</h2>
          <Link href="/app/governance/recommendations" className="text-xs font-medium text-sky-700 hover:text-sky-800">
            すべて見る
          </Link>
        </div>
        {topRecommendations.length > 0 ? (
          <ul className="mt-4 grid gap-3 md:grid-cols-3">
            {topRecommendations.map((item) => (
              <li key={item.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p
                  className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                    item.priority === "critical"
                      ? "bg-rose-100 text-rose-700"
                      : item.priority === "high"
                        ? "bg-amber-100 text-amber-700"
                        : item.priority === "medium"
                          ? "bg-sky-100 text-sky-700"
                          : "bg-emerald-100 text-emerald-700"
                  }`}
                >
                  {item.priority}
                </p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{item.title}</p>
                <p className="mt-1 text-xs text-slate-600">
                  {item.metricLabel}: <span className="font-semibold text-slate-700">{item.metricValue}</span>
                </p>
                <p className="mt-2 line-clamp-2 text-xs text-slate-600">{item.description}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">改善提案はありません。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">タスクステータス分布</h2>
          <span className="text-xs text-slate-500">0件は棒を表示しません</span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {taskStatusOrder.map((status) => {
            const count = taskStatusCounts.get(status) ?? 0;
            const heightPct = count > 0 ? Math.max(12, Math.round((count / maxTaskCount) * 100)) : 0;
            return (
              <div key={status} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="flex h-36 items-end justify-center rounded-md bg-white px-2">
                  {count > 0 ? (
                    <div className={`w-10 rounded-t-md ${statusColor(status)}`} style={{ height: `${heightPct}%` }} />
                  ) : null}
                </div>
                <p className="mt-2 text-center font-mono text-[11px] text-slate-600">{status}</p>
                <p className="text-center text-sm font-semibold text-slate-900">{count}</p>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
        {links.map((item, idx) => (
          <Link
            key={item.href}
            href={item.href}
            className={`group rounded-xl border p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${idx % 5 === 0 ? "xl:col-span-5 bg-gradient-to-br from-white to-teal-50 border-teal-200" : idx % 5 === 1 ? "xl:col-span-3 bg-gradient-to-br from-white to-slate-50 border-slate-200" : "xl:col-span-4 bg-white border-slate-200"}`}
          >
            <h2 className="font-medium text-slate-900">{item.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{item.description}</p>
            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-teal-700 group-hover:text-teal-800">
              {item.title}を開く
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}
