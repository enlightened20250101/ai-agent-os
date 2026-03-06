import Link from "next/link";
import { runGuardedAutoReminderNow } from "@/app/app/approvals/actions";
import { sendHighRiskInsufficientRemindersNow } from "@/app/app/approvals/actions";
import { bulkRetryFailedCommands } from "@/app/app/chat/actions";
import { expireStaleChatConfirmations } from "@/app/app/chat/actions";
import { retryTopFailedWorkflowRuns } from "@/app/app/operations/exceptions/actions";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { getHighRiskThreshold, getRequiredApprovalCountForRisk } from "@/lib/governance/guardrails";
import { buildGovernanceRecommendations } from "@/lib/governance/recommendations";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

type HomePageProps = {
  searchParams?: Promise<{ ok?: string; error?: string; window?: string }>;
};

const links = [
  {
    title: "ワークスペース",
    href: "/app/workspace",
    description: "所属メンバーと招待リンクを一覧で確認し、共有運用を管理します。"
  },
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
    title: "実行履歴",
    href: "/app/executions",
    description: "AI実行の監査ログを期間・依頼元などで横断検索します。"
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
    title: "監視ティック",
    href: "/app/monitor",
    description: "滞留や失敗シグナルを監視し、必要時のみプランナーを自動起動します。"
  },
  {
    title: "外部イベント",
    href: "/app/events",
    description: "Gmail/Slack/Webhook 等の取り込みイベントを確認し、未処理を仕分けます。"
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
    title: "チャンネル",
    href: "/app/chat/channels",
    description: "Slack風に複数チャンネルを作成し、招待して会話できます。"
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
    title: "信頼スコア",
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

function parseDraftRisksFromModelPayload(payload: unknown) {
  const obj = asObject(payload);
  const output = asObject(obj?.output);
  if (!output || !Array.isArray(output.risks)) return [];
  return output.risks.filter((item): item is string => typeof item === "string");
}

function withWindowParam(href: string, windowFilter: "24h" | "7d" | "30d") {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}window=${windowFilter}`;
}

function formatWindowLabel(windowFilter: "24h" | "7d" | "30d") {
  if (windowFilter === "24h") return "24時間";
  if (windowFilter === "30d") return "30日";
  return "7日";
}

function taskStatusLabel(status: string) {
  if (status === "draft") return "下書き";
  if (status === "ready_for_approval") return "承認依頼待ち";
  if (status === "approved") return "承認済み";
  if (status === "executing") return "実行中";
  if (status === "done") return "完了";
  if (status === "failed") return "失敗";
  return status;
}

function intentLabel(intentType: string) {
  if (intentType === "request_approval") return "承認依頼";
  if (intentType === "execute_action") return "アクション実行";
  if (intentType === "quick_top_action") return "クイック実行";
  if (intentType === "run_workflow") return "ワークフロー実行";
  if (intentType === "bulk_retry_failed_workflows") return "失敗WF一括再試行";
  if (intentType === "run_planner") return "プランナー実行";
  return intentType;
}

function recommendationPriorityLabel(priority: "critical" | "high" | "medium" | "low") {
  if (priority === "critical") return "最優先";
  if (priority === "high") return "高";
  if (priority === "medium") return "中";
  return "低";
}

function recommendationMetricLabel(label: string) {
  if (label === "open incidents") return "オープンインシデント";
  if (label === "pending >72h") return "72時間超の承認待ち";
  if (label === "pending >24h") return "24時間超の承認待ち";
  if (label === "failed actions (7d)") return "失敗アクション(7日)";
  if (label === "success rate (7d)") return "成功率(7日)";
  if (label === "overdue chat confirmations") return "期限切れチャット確認";
  if (label === "pending chat confirmations") return "保留中チャット確認";
  if (label === "failed chat commands (7d)") return "失敗チャット実行(7日)";
  if (label === "low trust rows (7d)") return "低信頼スコア件数(7日)";
  if (label === "policy blocks (7d)") return "ポリシーブロック件数(7日)";
  if (label === "daily remaining") return "日次予算残量";
  if (label === "auto execute") return "自動実行状態";
  if (label === "health") return "健全性";
  return label;
}

function recommendationMetricValue(label: string, value: string) {
  if (label === "auto execute" && value === "enabled") return "有効";
  if (label === "health" && value === "stable") return "安定";
  return value;
}

function skipRecommendation(reason: string | null, windowFilter: "24h" | "7d" | "30d") {
  if (reason === "approval_not_pending") {
    return {
      text: "承認待ちの先行解消が多発。承認キューを先に確認。",
      href: withWindowParam("/app/chat/audit?skip_reason=approval_not_pending", windowFilter),
      severity: "medium" as const
    };
  }
  if (reason === "approval_already_pending") {
    return {
      text: "重複依頼が多発。既存pending優先に運用統一。",
      href: withWindowParam("/app/chat/audit?skip_reason=approval_already_pending", windowFilter),
      severity: "low" as const
    };
  }
  if (reason === "stale_top_candidates") {
    return {
      text: "TOP候補が陳腐化。先に状況確認を再実行。",
      href: withWindowParam("/app/chat/audit?skip_reason=stale_top_candidates", windowFilter),
      severity: "high" as const
    };
  }
  return { text: "skip要因を監査画面で確認。", href: withWindowParam("/app/chat/audit", windowFilter), severity: "low" as const };
}

function parseQuickActionResult(message: string | undefined) {
  if (!message) return null;
  const retryMatch = message.match(/success=(\d+),\s*failed=(\d+)/);
  if (retryMatch) {
    return {
      kind: "workflow_retry" as const,
      success: Number.parseInt(retryMatch[1] ?? "0", 10),
      failed: Number.parseInt(retryMatch[2] ?? "0", 10)
    };
  }
  const expireMatch = message.match(/期限切れ確認を(\d+)件更新/);
  if (expireMatch) {
    return {
      kind: "expire_confirmations" as const,
      updated: Number.parseInt(expireMatch[1] ?? "0", 10)
    };
  }
  return null;
}

function resolveWindowHours(windowValue: string) {
  if (windowValue === "24h") return 24;
  if (windowValue === "30d") return 24 * 30;
  return 24 * 7;
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
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

function resolveSloTone(successRate: number | null, mttrMinutes: number | null) {
  const isRateCritical = successRate !== null && successRate < 0.7;
  const isRateWarn = successRate !== null && successRate < 0.9;
  const isMttrCritical = mttrMinutes !== null && mttrMinutes > 240;
  const isMttrWarn = mttrMinutes !== null && mttrMinutes > 60;
  if (isRateCritical || isMttrCritical) {
    return { label: "要改善", className: "border-rose-300 bg-rose-50 text-rose-900", subClass: "text-rose-700" };
  }
  if (isRateWarn || isMttrWarn) {
    return { label: "注意", className: "border-amber-300 bg-amber-50 text-amber-900", subClass: "text-amber-700" };
  }
  return { label: "安定", className: "border-emerald-200 bg-emerald-50 text-emerald-900", subClass: "text-emerald-700" };
}

export default async function AppHomePage({ searchParams }: HomePageProps) {
  const sp = searchParams ? await searchParams : {};
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const windowFilter = sp.window === "24h" || sp.window === "30d" ? sp.window : "7d";
  const windowLabel = formatWindowLabel(windowFilter);
  const windowHours = resolveWindowHours(windowFilter);
  const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const staleApprovalHours = Number(process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6");
  const staleApprovalCutoffIso = new Date(Date.now() - staleApprovalHours * 60 * 60 * 1000).toISOString();
  const autoMinStaleRaw = Number.parseInt(process.env.APPROVAL_REMINDER_AUTO_MIN_STALE ?? "3", 10);
  const autoMinStale = Number.isNaN(autoMinStaleRaw) ? 3 : Math.max(1, Math.min(1000, autoMinStaleRaw));
  const staleCaseHours = Number(process.env.CASE_STALE_HOURS ?? "48");
  const staleCaseCutoffIso = new Date(Date.now() - staleCaseHours * 60 * 60 * 1000).toISOString();
  const [
    tasksRes,
    approvalsRes,
    actionsRes,
    incidentsRes,
    recommendationPack,
    plannerRunsRes,
    reviewEventsRes,
    proposalsRes,
    externalEventsRes,
    chatCommandsRes,
    chatIntentsRes,
    casesRes,
    autoReminderEventsRes,
    retryEventsRes,
    externalCaseEventsRes,
    approvalRiskRes,
    approvalPolicyRes,
    approvalModelRes,
    approvalApproverRes,
    approvalTaskCreatorRes
  ] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("approvals")
      .select("id, task_id, status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("actions")
      .select("id, status, created_at")
      .eq("org_id", orgId)
      .gte("created_at", windowStartIso)
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
      .select("id, source, status, policy_status, created_at, decided_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("external_events")
      .select("id, status, created_at")
      .eq("org_id", orgId)
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("chat_commands")
      .select("id, intent_id, execution_status, created_at, result_json")
      .eq("org_id", orgId)
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("chat_intents")
      .select("id, intent_type, created_at")
      .eq("org_id", orgId)
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase
      .from("business_cases")
      .select("id, status, updated_at")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(1000),
    supabase
      .from("task_events")
      .select("event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["APPROVAL_REMINDER_AUTO_RUN", "APPROVAL_REMINDER_AUTO_SKIPPED"])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("task_events")
      .select("event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("event_type", ["OPS_JOB_RETRY_RECOVERED", "OPS_JOB_RETRY_EXHAUSTED"])
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("case_events")
      .select("event_type, created_at")
      .eq("org_id", orgId)
      .eq("event_type", "CASE_CREATED_FROM_EXTERNAL_EVENT")
      .gte("created_at", windowStartIso)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("risk_assessments")
      .select("task_id, risk_score, created_at")
      .eq("org_id", orgId)
      .not("task_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("task_events")
      .select("task_id, payload_json, created_at")
      .eq("org_id", orgId)
      .eq("event_type", "POLICY_CHECKED")
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("task_events")
      .select("task_id, payload_json, created_at")
      .eq("org_id", orgId)
      .eq("event_type", "MODEL_INFERRED")
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("approvals")
      .select("task_id, approver_user_id")
      .eq("org_id", orgId)
      .eq("status", "approved")
      .limit(5000),
    supabase
      .from("tasks")
      .select("id, created_by_user_id")
      .eq("org_id", orgId)
      .limit(2000)
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
    externalEventsRes.error &&
    !externalEventsRes.error.message.includes('relation "external_events" does not exist') &&
    !externalEventsRes.error.message.includes("Could not find the table 'public.external_events'")
  ) {
    throw new Error(`Failed to load external event metrics: ${externalEventsRes.error.message}`);
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
  if (
    casesRes.error &&
    !casesRes.error.message.includes('relation "business_cases" does not exist') &&
    !casesRes.error.message.includes("Could not find the table 'public.business_cases'")
  ) {
    throw new Error(`Failed to load case metrics: ${casesRes.error.message}`);
  }
  if (autoReminderEventsRes.error) {
    throw new Error(`Failed to load auto reminder metrics: ${autoReminderEventsRes.error.message}`);
  }
  if (retryEventsRes.error) {
    throw new Error(`Failed to load retry metrics: ${retryEventsRes.error.message}`);
  }
  if (
    externalCaseEventsRes.error &&
    !externalCaseEventsRes.error.message.includes('relation "case_events" does not exist') &&
    !externalCaseEventsRes.error.message.includes("Could not find the table 'public.case_events'")
  ) {
    throw new Error(`Failed to load external case metrics: ${externalCaseEventsRes.error.message}`);
  }
  if (approvalRiskRes.error) {
    throw new Error(`Failed to load approval risk metrics: ${approvalRiskRes.error.message}`);
  }
  if (approvalPolicyRes.error) {
    throw new Error(`Failed to load approval policy metrics: ${approvalPolicyRes.error.message}`);
  }
  if (approvalModelRes.error) {
    throw new Error(`Failed to load approval model metrics: ${approvalModelRes.error.message}`);
  }
  if (approvalApproverRes.error) {
    throw new Error(`Failed to load approval approver metrics: ${approvalApproverRes.error.message}`);
  }
  if (approvalTaskCreatorRes.error) {
    throw new Error(`Failed to load approval task creator metrics: ${approvalTaskCreatorRes.error.message}`);
  }

  const tasks = tasksRes.data ?? [];
  const approvals = approvalsRes.data ?? [];
  const actions = actionsRes.data ?? [];
  const openIncidents = incidentsRes.data ?? [];
  const plannerRuns = plannerRunsRes.data ?? [];
  const reviewEvents = reviewEventsRes.data ?? [];
  const proposals = proposalsRes.data ?? [];
  const externalEvents = externalEventsRes.data ?? [];
  const chatCommands = chatCommandsRes.data ?? [];
  const chatIntents = chatIntentsRes.data ?? [];
  const cases = casesRes.data ?? [];
  const autoReminderEvents = autoReminderEventsRes.data ?? [];
  const retryEvents = retryEventsRes.data ?? [];
  const externalCaseEvents = externalCaseEventsRes.data ?? [];
  const highRiskThreshold = getHighRiskThreshold();

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
  const pendingApprovalRows = approvals.filter((row) => row.status === "pending") as Array<{ id: string; status: string; task_id?: string | null }>;
  const pendingTaskIds = Array.from(
    new Set(
      pendingApprovalRows
        .map((row) => (typeof row.task_id === "string" ? row.task_id : null))
        .filter((value): value is string => Boolean(value))
    )
  );
  const creatorByTaskId = new Map<string, string | null>(
    ((approvalTaskCreatorRes.data ?? []) as Array<{ id: string; created_by_user_id: string | null }>).map((row) => [
      row.id,
      row.created_by_user_id
    ])
  );
  const riskScoreByTaskId = new Map<string, number>();
  for (const row of approvalRiskRes.data ?? []) {
    const taskId = row.task_id as string | null;
    if (!taskId || riskScoreByTaskId.has(taskId)) continue;
    const score = Number(row.risk_score ?? NaN);
    if (Number.isFinite(score)) {
      riskScoreByTaskId.set(taskId, Math.max(0, Math.min(100, Math.round(score))));
    }
  }
  const policyByTaskId = new Map<string, "pass" | "warn" | "block">();
  for (const row of approvalPolicyRes.data ?? []) {
    const taskId = row.task_id as string | null;
    if (!taskId || policyByTaskId.has(taskId)) continue;
    const payload = asObject(row.payload_json);
    const status = payload?.status;
    if (status === "pass" || status === "warn" || status === "block") {
      policyByTaskId.set(taskId, status);
    }
  }
  const draftRiskCountByTaskId = new Map<string, number>();
  for (const row of approvalModelRes.data ?? []) {
    const taskId = row.task_id as string | null;
    if (!taskId || draftRiskCountByTaskId.has(taskId)) continue;
    draftRiskCountByTaskId.set(taskId, parseDraftRisksFromModelPayload(row.payload_json).length);
  }
  const approversByTaskId = new Map<string, Set<string>>();
  for (const row of approvalApproverRes.data ?? []) {
    const taskId = row.task_id as string | null;
    const approver = (row.approver_user_id as string | null | undefined) ?? null;
    if (!taskId || !approver) continue;
    const creator = creatorByTaskId.get(taskId) ?? null;
    if (creator && creator === approver) continue;
    const set = approversByTaskId.get(taskId) ?? new Set<string>();
    set.add(approver);
    approversByTaskId.set(taskId, set);
  }
  const highRiskInsufficientPending = pendingTaskIds.filter((taskId) => {
    const policy = policyByTaskId.get(taskId) ?? "pass";
    const draftRisks = draftRiskCountByTaskId.get(taskId) ?? 0;
    const riskScore =
      riskScoreByTaskId.get(taskId) ??
      Math.min(100, 20 + (policy === "block" ? 50 : policy === "warn" ? 15 : 0) + Math.min(20, draftRisks * 5));
    const required = getRequiredApprovalCountForRisk(riskScore);
    const approvedDistinct = approversByTaskId.get(taskId)?.size ?? 0;
    return required > 0 && approvedDistinct < required;
  }).length;
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
  const pendingExternalEvents = externalEvents.filter((row) => row.status === "new").length;
  const externalEventProposals = proposals.filter(
    (row) =>
      typeof row.source === "string" &&
      row.source.startsWith("planner_seed_external_event_") &&
      typeof row.created_at === "string" &&
      row.created_at >= windowStartIso
  );
  const externalEventProposalAccepted = externalEventProposals.filter(
    (row) => row.status === "accepted" || row.status === "executed"
  ).length;
  const externalEventProposalAdoptionRate =
    externalEventProposals.length > 0
      ? Math.round((externalEventProposalAccepted / externalEventProposals.length) * 100)
      : null;
  const externalProposalDecisionHours = externalEventProposals
    .map((row) => {
      if (typeof row.created_at !== "string" || typeof row.decided_at !== "string") return null;
      const createdMs = new Date(row.created_at).getTime();
      const decidedMs = new Date(row.decided_at).getTime();
      if (!Number.isFinite(createdMs) || !Number.isFinite(decidedMs) || decidedMs < createdMs) return null;
      return (decidedMs - createdMs) / (1000 * 60 * 60);
    })
    .filter((value): value is number => value !== null);
  const avgExternalProposalDecisionHours =
    externalProposalDecisionHours.length > 0
      ? Number(
          (
            externalProposalDecisionHours.reduce((sum, value) => sum + value, 0) /
            externalProposalDecisionHours.length
          ).toFixed(1)
        )
      : null;
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
  const skipReco = skipRecommendation(topSkipReason, windowFilter);
  const chatSkipHref = topSkipReason
    ? withWindowParam(`/app/chat/audit?skip_reason=${encodeURIComponent(topSkipReason)}`, windowFilter)
    : withWindowParam("/app/chat/audit", windowFilter);
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
    ? withWindowParam(`/app/chat/audit?status=failed&intent=${encodeURIComponent(worstFailedIntent.intentType)}`, windowFilter)
    : withWindowParam("/app/chat/audit?status=failed", windowFilter);
  const actionSuccessRate =
    executedActions + failedActions > 0
      ? Math.round((executedActions / (executedActions + failedActions)) * 100)
      : null;
  const openCases = cases.filter((row) => row.status === "open").length;
  const staleOpenCases = cases.filter(
    (row) => row.status === "open" && typeof row.updated_at === "string" && row.updated_at < staleCaseCutoffIso
  ).length;
  const autoRunCount = autoReminderEvents.filter((row) => row.event_type === "APPROVAL_REMINDER_AUTO_RUN").length;
  const autoSkippedCount = autoReminderEvents.filter((row) => row.event_type === "APPROVAL_REMINDER_AUTO_SKIPPED").length;
  const latestAutoEvent = autoReminderEvents[0] ?? null;
  const latestAutoPayload = asObject(latestAutoEvent?.payload_json ?? null);
  const previousAutoEvent = autoReminderEvents[1] ?? null;
  const previousAutoPayload = asObject(previousAutoEvent?.payload_json ?? null);
  const latestAutoStale = Number(latestAutoPayload?.stale_pending_count ?? NaN);
  const previousAutoStale = Number(previousAutoPayload?.stale_pending_count ?? NaN);
  const autoDelta =
    Number.isFinite(latestAutoStale) && Number.isFinite(previousAutoStale)
      ? latestAutoStale - previousAutoStale
      : null;
  const suggestedGuardMinStale =
    stalePendingApprovals >= 10 ? 10 : stalePendingApprovals >= 5 ? 5 : stalePendingApprovals >= 3 ? 3 : 1;
  const urgentGuardMinStale =
    autoDelta !== null && autoDelta > 0
      ? Math.max(1, Math.min(suggestedGuardMinStale, Math.max(1, stalePendingApprovals - 1)))
      : suggestedGuardMinStale;
  const autoReason = typeof latestAutoPayload?.reason === "string" ? latestAutoPayload.reason : "なし";
  const autoDeltaText =
    autoDelta === null ? "変化量=なし" : autoDelta > 0 ? `変化量=+${autoDelta}` : `変化量=${autoDelta}`;
  const autoQueueSummary = `${autoReason} / ${autoDeltaText}`;
  const isAutoWorsening = autoDelta !== null && autoDelta > 0;
  const autoSummaryTextClass =
    autoDelta === null
      ? "text-slate-600"
      : autoDelta > 0
        ? "text-rose-700"
        : autoDelta < 0
          ? "text-emerald-700"
          : "text-amber-700";

  const urgentSignals = [
    openIncidents.length > 0 ? `インシデント ${openIncidents.length}件` : null,
    (taskStatusCounts.get("failed") ?? 0) > 0 ? `失敗タスク ${taskStatusCounts.get("failed") ?? 0}件` : null,
    pendingApprovals > 5 ? `承認待ち ${pendingApprovals}件` : null,
    highRiskInsufficientPending > 0 ? `高リスク承認不足 ${highRiskInsufficientPending}件` : null,
    failedActions > 0 ? `直近${windowLabel}アクション失敗 ${failedActions}件` : null,
    failedChatCommands > 0 ? `直近${windowLabel}チャット失敗 ${failedChatCommands}件` : null,
    staleOpenCases > 0 ? `滞留案件 ${staleOpenCases}件` : null,
    worstFailedIntent && worstFailedIntent.failureRate >= 50
      ? `高失敗意図 ${intentLabel(worstFailedIntent.intentType)} (${worstFailedIntent.failureRate}%)`
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
  const plannerCompleted = plannerRuns.filter((row) => row.status === "completed").length;
  const plannerFailed = plannerRuns.filter((row) => row.status === "failed").length;
  const plannerAttempts = plannerCompleted + plannerFailed;
  const plannerSuccessRate = plannerAttempts > 0 ? plannerCompleted / plannerAttempts : null;
  const plannerMttrMinutes = computeMttrMinutes(
    plannerRuns.map((row) => ({
      created_at: String(row.created_at ?? ""),
      isFailure: row.status === "failed",
      isSuccess: row.status === "completed"
    }))
  );
  const reviewSuccess = reviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEWED").length;
  const reviewFailed = reviewEvents.filter((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED").length;
  const reviewAttempts = reviewSuccess + reviewFailed;
  const reviewSuccessRate = reviewAttempts > 0 ? reviewSuccess / reviewAttempts : null;
  const reviewMttrMinutes = computeMttrMinutes(
    reviewEvents.map((row) => ({
      created_at: String(row.created_at ?? ""),
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
  const workflowSuccessRate = workflowAttempts > 0 ? workflowRecovered / workflowAttempts : null;
  const workflowMttrMinutes = computeMttrMinutes(
    retryEvents
      .filter((row) => {
        const payload = asObject(row.payload_json);
        const jobName = typeof payload?.job_name === "string" ? payload.job_name : "";
        return jobName === "workflow_tick_batch" || jobName === "workflow_tick_single";
      })
      .map((row) => ({
        created_at: String(row.created_at ?? ""),
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
  const autoCaseifySuccessRate = autoCaseifyAttempts > 0 ? autoCaseifyRecovered / autoCaseifyAttempts : null;
  const autoCaseifyMttrMinutes = computeMttrMinutes(
    retryEvents
      .filter((row) => {
        const payload = asObject(row.payload_json);
        return payload?.job_name === "events_auto_caseify_batch";
      })
      .map((row) => ({
        created_at: String(row.created_at ?? ""),
        isFailure: row.event_type === "OPS_JOB_RETRY_EXHAUSTED",
        isSuccess: row.event_type === "OPS_JOB_RETRY_RECOVERED"
      }))
  );
  const autoCaseifyCount = externalCaseEvents.length;
  const quickResult = parseQuickActionResult(sp.ok);
  const sloCards = [
    {
      key: "planner",
      label: "Planner",
      successRate: plannerSuccessRate,
      mttr: plannerMttrMinutes,
      meta: `${plannerCompleted}/${plannerAttempts} 成功`,
      href: withWindowParam("/app/operations/jobs?failed_only=1&focus=planner", windowFilter)
    },
    {
      key: "review",
      label: "Governance Review",
      successRate: reviewSuccessRate,
      mttr: reviewMttrMinutes,
      meta: `${reviewSuccess}/${reviewAttempts} 成功`,
      href: withWindowParam("/app/operations/jobs?failed_only=1&focus=review", windowFilter)
    },
    {
      key: "caseify",
      label: "Events Auto-Caseify",
      successRate: autoCaseifySuccessRate,
      mttr: autoCaseifyMttrMinutes,
      meta: `Case化 ${autoCaseifyCount}件`,
      href: withWindowParam("/app/operations/jobs?failed_only=1&focus=caseify", windowFilter)
    },
    {
      key: "workflow",
      label: "Workflow Tick",
      successRate: workflowSuccessRate,
      mttr: workflowMttrMinutes,
      meta: `${workflowRecovered}/${workflowAttempts} 回復`,
      href: withWindowParam("/app/operations/jobs?failed_only=1&focus=workflow", windowFilter)
    }
  ]
    .map((item) => {
      const tone = resolveSloTone(item.successRate, item.mttr);
      const priority = tone.label === "要改善" ? 3 : tone.label === "注意" ? 2 : 1;
      return { ...item, tone, priority };
    })
    .sort((a, b) => b.priority - a.priority);
  const nextActions = [
    {
      key: "open_incidents",
      label: "オープンインシデントを確認",
      href: "/app/governance/incidents",
      score: openIncidents.length > 0 ? 100 + openIncidents.length * 5 : 0,
      detail: `オープン ${openIncidents.length}件`,
      quickAction: null as null | "retry_failed_workflows" | "expire_chat_confirmations"
    },
    {
      key: "failed_actions_24h",
      label: "失敗アクションをトリアージ",
      href: "/app/operations/exceptions",
      score: failedActions24h > 0 ? 85 + Math.min(15, failedActions24h) : 0,
      detail: `24時間 失敗 ${failedActions24h}件`,
      quickAction: "retry_failed_workflows" as const
    },
    {
      key: "stale_approvals",
      label: "滞留承認を処理",
      href: "/app/approvals",
      score: stalePendingApprovals > 0 ? 80 + Math.min(20, stalePendingApprovals) : 0,
      detail: `${staleApprovalHours}時間超 承認待ち ${stalePendingApprovals}件`,
      quickAction: null as null | "retry_failed_workflows" | "expire_chat_confirmations"
    },
    {
      key: "high_risk_insufficient",
      label: "高リスク承認不足を解消",
      href: "/app/approvals?high_risk_only=1",
      score: highRiskInsufficientPending > 0 ? 90 + Math.min(10, highRiskInsufficientPending) : 0,
      detail: `不足 ${highRiskInsufficientPending}件 (閾値=${highRiskThreshold})`,
      quickAction: null as null | "retry_failed_workflows" | "expire_chat_confirmations"
    },
    {
      key: "stale_cases",
      label: "滞留案件を解消",
      href: "/app/cases?status=open",
      score: staleOpenCases > 0 ? 78 + Math.min(20, staleOpenCases) : 0,
      detail: `${staleCaseHours}時間超 進行中 ${staleOpenCases}件`,
      quickAction: null as null | "retry_failed_workflows" | "expire_chat_confirmations"
    },
    {
      key: "auto_guard",
      label: "Auto Guard再通知",
      href: "/app/approvals",
      score: stalePendingApprovals >= autoMinStale ? 82 + Math.min(15, stalePendingApprovals) : 0,
      detail: `滞留=${stalePendingApprovals}, 閾値=${autoMinStale}, ${autoQueueSummary}`,
      quickAction: null as null | "retry_failed_workflows" | "expire_chat_confirmations"
    },
    {
      key: "blocked_proposals",
      label: "ポリシーブロック提案を精査",
      href: "/app/proposals?status=proposed&policy_status=block",
      score: blockedProposals > 0 ? 70 + Math.min(20, blockedProposals) : 0,
      detail: `ブロック提案 ${blockedProposals}件`,
      quickAction: null as null | "retry_failed_workflows" | "expire_chat_confirmations"
    },
    {
      key: "failed_chat_intent",
      label: "高失敗意図を復旧",
      href: worstIntentHref,
      score: worstFailedIntent ? Math.min(95, worstFailedIntent.failureRate) : 0,
      detail: worstFailedIntent
        ? `${intentLabel(worstFailedIntent.intentType)} ${worstFailedIntent.failed}/${worstFailedIntent.total}`
        : "ホットスポットなし",
      quickAction: "expire_chat_confirmations" as const
    },
    {
      key: "planner_failures",
      label: "ジョブ連続失敗を確認",
      href: "/app/operations/jobs?failed_only=1",
      score: needsOpsAttention ? 75 + Math.max(plannerConsecutiveFailures, reviewConsecutiveFailures) * 3 : 0,
      detail: `プランナー=${plannerConsecutiveFailures}, レビュー=${reviewConsecutiveFailures}`,
      quickAction: "retry_failed_workflows" as const
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
            <p className="text-xs uppercase tracking-[0.18em] text-teal-200/90">運用コンソール</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">AI Agent OS ワークスペース</h1>
            <p className="mt-3 text-sm text-slate-200/90">
              日次オペレーションの状態を一画面で確認し、異常や滞留があれば優先的に対処できます。
            </p>
            <p className="mt-4 inline-flex rounded-full border border-white/30 bg-white/10 px-3 py-1 text-xs text-slate-100">
              ワークスペース: 現在
            </p>
            <span data-testid="org-context-id" className="sr-only">
              {orgId}
            </span>
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
                プランナー連続失敗 {plannerConsecutiveFailures}件 / レビュー連続失敗 {reviewConsecutiveFailures}件
              </p>
            </div>
            <Link
              href={withWindowParam("/app/operations/jobs?failed_only=1", windowFilter)}
              className="rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-medium text-rose-800 hover:bg-rose-100"
            >
              失敗ジョブを確認
            </Link>
          </div>
        </section>
      ) : null}
      {sp.error ? (
        <section className="rounded-xl border border-rose-300 bg-rose-50 p-4 shadow-sm">
          <p className="text-sm font-semibold text-rose-900">クイック実行エラー</p>
          <p className="mt-1 text-xs text-rose-800">{sp.error}</p>
        </section>
      ) : null}
      {sp.ok ? (
        <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 shadow-sm">
          <p className="text-sm font-semibold text-emerald-900">クイック実行結果</p>
          <p className="mt-1 text-xs text-emerald-800">{sp.ok}</p>
          {quickResult?.kind === "workflow_retry" ? (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md border border-emerald-300 bg-white px-2 py-1 text-emerald-800">
                成功: {quickResult.success}
              </span>
              <span className="rounded-md border border-rose-300 bg-white px-2 py-1 text-rose-800">
                失敗: {quickResult.failed}
              </span>
            </div>
          ) : null}
          {quickResult?.kind === "expire_confirmations" ? (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md border border-sky-300 bg-white px-2 py-1 text-sky-800">
                期限切れ更新: {quickResult.updated}
              </span>
            </div>
          ) : null}
        </section>
      ) : null}
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <p className="text-xs text-slate-600">集計期間: {windowLabel}</p>
        <div className="flex items-center gap-2">
          {[
            { value: "24h", label: "24時間" },
            { value: "7d", label: "7日" },
            { value: "30d", label: "30日" }
          ].map((option) => {
            const active = windowFilter === option.value;
            return (
              <Link
                key={option.value}
                href={`/app?window=${option.value}`}
                className={`rounded-md border px-2 py-1 text-xs ${
                  active
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                {option.label}
              </Link>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">運用SLO要約</p>
          <Link
            href={withWindowParam("/app/operations/jobs?failed_only=1", windowFilter)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
          >
            ジョブ監視へ
          </Link>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {sloCards.map((item) => (
            <Link key={item.key} href={item.href} className={`rounded-lg border p-3 transition hover:opacity-90 ${item.tone.className}`}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">{item.label}</p>
                  <span className={`rounded-full border bg-white/70 px-2 py-0.5 text-[10px] font-semibold ${item.tone.subClass}`}>
                    {item.tone.label}
                  </span>
                </div>
                <p className="mt-1 text-lg font-semibold">成功率 {formatPercent(item.successRate)}</p>
                <p className="text-xs">MTTR: {formatDurationMinutes(item.mttr)}</p>
                <p className="mt-1 text-[11px] opacity-80">{item.meta}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">主要導線</p>
          <span className="text-xs text-slate-500">日次運用でよく使う画面</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Link href={withWindowParam("/app/approvals", windowFilter)} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100">
            承認キュー
          </Link>
          <Link href={withWindowParam("/app/operations/exceptions", windowFilter)} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900 hover:bg-rose-100">
            例外キュー
          </Link>
          <Link href={withWindowParam("/app/chat/audit?status=failed", windowFilter)} className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 hover:bg-sky-100">
            チャット監査
          </Link>
          <Link href={withWindowParam("/app/operations/jobs?failed_only=1", windowFilter)} className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900 hover:bg-indigo-100">
            ジョブ監視
          </Link>
        </div>
      </section>

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
          <p className="text-xs text-teal-700">{windowLabel}成功率</p>
          <p className="mt-1 text-2xl font-semibold text-teal-900">{actionSuccessRate !== null ? `${actionSuccessRate}%` : "-"}</p>
        </div>
        <div className={`rounded-xl border p-4 shadow-sm ${openIncidents.length > 0 ? "border-rose-300 bg-rose-100" : "border-emerald-200 bg-emerald-50"}`}>
          <p className={`text-xs ${openIncidents.length > 0 ? "text-rose-700" : "text-emerald-700"}`}>オープンインシデント</p>
          <p className={`mt-1 text-2xl font-semibold ${openIncidents.length > 0 ? "text-rose-900" : "text-emerald-900"}`}>{openIncidents.length}</p>
        </div>
        <Link
          href={withWindowParam("/app/governance/recommendations", windowFilter)}
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
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Link
          href={withWindowParam("/app/cases?status=open", windowFilter)}
          className={`rounded-xl border p-4 shadow-sm ${staleOpenCases > 0 ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}
        >
          <p className={`text-xs ${staleOpenCases > 0 ? "text-rose-700" : "text-slate-600"}`}>滞留案件 ({staleCaseHours}h+)</p>
          <p className={`mt-1 text-2xl font-semibold ${staleOpenCases > 0 ? "text-rose-900" : "text-slate-900"}`}>{staleOpenCases}</p>
            <p className="mt-1 text-[11px] text-slate-600">進行中案件総数: {openCases}</p>
        </Link>
        <div className={`rounded-xl border p-4 shadow-sm ${stalePendingApprovals >= autoMinStale ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-slate-50"}`}>
          <p className={`text-xs ${stalePendingApprovals >= autoMinStale ? "text-indigo-700" : "text-slate-600"}`}>
            Auto Guard ({autoMinStale}件閾値)
          </p>
          {isAutoWorsening ? (
            <form action={runGuardedAutoReminderNow} className="mt-2">
              <input type="hidden" name="window" value={windowFilter} />
              <input type="hidden" name="min_stale" value={String(suggestedGuardMinStale)} />
              <ConfirmSubmitButton
                label={`優先実行: 推奨値(${suggestedGuardMinStale})`}
                pendingLabel="実行中..."
                confirmMessage={`Auto Guardを推奨閾値 ${suggestedGuardMinStale} で実行します。よろしいですか？`}
                className="rounded-md border border-rose-600 bg-rose-600 px-2 py-1 text-xs font-semibold text-white hover:bg-rose-700"
              />
            </form>
          ) : null}
            <p className={`mt-1 text-2xl font-semibold ${stalePendingApprovals >= autoMinStale ? "text-indigo-900" : "text-slate-900"}`}>
            滞留 {stalePendingApprovals}
          </p>
          <p className="mt-1 text-[11px] text-slate-600">実行: {autoRunCount} / スキップ: {autoSkippedCount}</p>
          <p className="mt-1 text-[11px] text-slate-600">
            delta: {autoDelta === null ? "-" : autoDelta > 0 ? `+${autoDelta}` : `${autoDelta}`}
          </p>
          {!isAutoWorsening ? (
            <form action={runGuardedAutoReminderNow} className="mt-2">
              <input type="hidden" name="window" value={windowFilter} />
              <input type="hidden" name="min_stale" value={String(suggestedGuardMinStale)} />
              <ConfirmSubmitButton
                label={`推奨値(${suggestedGuardMinStale})で実行`}
                pendingLabel="実行中..."
                confirmMessage={`Auto Guardを推奨閾値 ${suggestedGuardMinStale} で実行します。よろしいですか？`}
                className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100"
              />
            </form>
          ) : null}
          {urgentGuardMinStale !== suggestedGuardMinStale ? (
            <form action={runGuardedAutoReminderNow} className="mt-2">
              <input type="hidden" name="window" value={windowFilter} />
              <input type="hidden" name="min_stale" value={String(urgentGuardMinStale)} />
              <ConfirmSubmitButton
                label={`悪化対応: 閾値${urgentGuardMinStale}で実行`}
                pendingLabel="実行中..."
                confirmMessage={`悪化傾向のため、閾値 ${urgentGuardMinStale} で緊急実行します。よろしいですか？`}
                className="rounded-md border border-rose-300 bg-rose-100 px-2 py-1 text-xs font-medium text-rose-800 hover:bg-rose-200"
              />
            </form>
          ) : null}
          {latestAutoEvent ? (
            <p className="mt-2 text-[11px] text-slate-500">
              最終実行: {new Date(latestAutoEvent.created_at as string).toLocaleString("ja-JP")} / {String(latestAutoEvent.event_type)}
            </p>
          ) : null}
        </div>
        <div
          className={`rounded-xl border p-4 shadow-sm ${
            highRiskInsufficientPending > 0 ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"
          }`}
        >
          <p className={`text-xs ${highRiskInsufficientPending > 0 ? "text-rose-700" : "text-slate-600"}`}>
            高リスク承認不足
          </p>
          <p className={`mt-1 text-2xl font-semibold ${highRiskInsufficientPending > 0 ? "text-rose-900" : "text-slate-900"}`}>
            {highRiskInsufficientPending}
          </p>
          <p className="mt-1 text-[11px] text-slate-600">閾値={highRiskThreshold}</p>
          <form action={sendHighRiskInsufficientRemindersNow} className="mt-2">
            <input type="hidden" name="window" value={windowFilter} />
            <ConfirmSubmitButton
              label="不足案件を再通知"
              pendingLabel="再通知中..."
              confirmMessage="高リスク承認不足の保留承認をSlackへ再通知します。実行しますか？"
              className="rounded-md border border-rose-300 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-100"
            />
          </form>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Link
          href={withWindowParam("/app/events?status=new", windowFilter)}
          className={`rounded-xl border p-4 shadow-sm ${
            pendingExternalEvents > 0 ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"
          }`}
        >
          <p className={`text-xs ${pendingExternalEvents > 0 ? "text-amber-700" : "text-slate-600"}`}>
            未処理外部イベント ({windowLabel})
          </p>
          <p className={`mt-1 text-2xl font-semibold ${pendingExternalEvents > 0 ? "text-amber-900" : "text-slate-900"}`}>
            {pendingExternalEvents}
          </p>
          <p className="mt-1 text-[11px] text-slate-600">外部イベント一覧へ</p>
        </Link>
        <Link
          href={withWindowParam("/app/proposals?source=planner_seed_external_event", windowFilter)}
          className={`rounded-xl border p-4 shadow-sm ${
            externalEventProposalAdoptionRate !== null && externalEventProposalAdoptionRate < 40
              ? "border-rose-300 bg-rose-50"
              : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <p
            className={`text-xs ${
              externalEventProposalAdoptionRate !== null && externalEventProposalAdoptionRate < 40
                ? "text-rose-700"
                : "text-emerald-700"
            }`}
          >
            外部イベント提案 採用率 ({windowLabel})
          </p>
          <p
            className={`mt-1 text-2xl font-semibold ${
              externalEventProposalAdoptionRate !== null && externalEventProposalAdoptionRate < 40
                ? "text-rose-900"
                : "text-emerald-900"
            }`}
          >
            {externalEventProposalAdoptionRate !== null ? `${externalEventProposalAdoptionRate}%` : "-"}
          </p>
          <p className="mt-1 text-[11px] text-slate-600">
            採用 {externalEventProposalAccepted} / 提案 {externalEventProposals.length}
          </p>
        </Link>
        <Link
          href={withWindowParam("/app/proposals?source=planner_seed_external_event", windowFilter)}
          className={`rounded-xl border p-4 shadow-sm ${
            avgExternalProposalDecisionHours !== null && avgExternalProposalDecisionHours > 24
              ? "border-rose-300 bg-rose-50"
              : "border-sky-200 bg-sky-50"
          }`}
        >
          <p
            className={`text-xs ${
              avgExternalProposalDecisionHours !== null && avgExternalProposalDecisionHours > 24
                ? "text-rose-700"
                : "text-sky-700"
            }`}
          >
            外部イベント提案 平均判断遅延
          </p>
          <p
            className={`mt-1 text-2xl font-semibold ${
              avgExternalProposalDecisionHours !== null && avgExternalProposalDecisionHours > 24
                ? "text-rose-900"
                : "text-sky-900"
            }`}
          >
            {avgExternalProposalDecisionHours !== null ? `${avgExternalProposalDecisionHours}h` : "-"}
          </p>
          <p className="mt-1 text-[11px] text-slate-600">decided_at がある提案のみ</p>
        </Link>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">優先対応キュー</h2>
          <span className="text-xs text-slate-500">緊急度の高いものを先頭表示</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-8">
          <Link
            href={withWindowParam("/app/approvals", windowFilter)}
            className={`rounded-lg border p-3 ${stalePendingApprovals > 0 ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className={`text-xs ${stalePendingApprovals > 0 ? "text-rose-700" : "text-slate-600"}`}>滞留承認 ({staleApprovalHours}h+)</p>
              {autoDelta !== null && autoDelta > 0 ? (
                <span className="animate-pulse rounded-full border border-rose-400 bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
                  悪化中
                </span>
              ) : null}
            </div>
            <p className={`mt-1 text-xl font-semibold ${stalePendingApprovals > 0 ? "text-rose-900" : "text-slate-900"}`}>{stalePendingApprovals}</p>
            <p className={`mt-1 text-[11px] ${autoSummaryTextClass}`}>自動判定: {autoQueueSummary}</p>
          </Link>
          <Link
            href={withWindowParam("/app/operations/exceptions", windowFilter)}
            className={`rounded-lg border p-3 ${failedActions24h > 0 ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className={`text-xs ${failedActions24h > 0 ? "text-amber-700" : "text-slate-600"}`}>24時間 失敗アクション</p>
            <p className={`mt-1 text-xl font-semibold ${failedActions24h > 0 ? "text-amber-900" : "text-slate-900"}`}>{failedActions24h}</p>
          </Link>
          <Link
            href={withWindowParam("/app/proposals?status=proposed&policy_status=block", windowFilter)}
            className={`rounded-lg border p-3 ${blockedProposals > 0 ? "border-fuchsia-300 bg-fuchsia-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className={`text-xs ${blockedProposals > 0 ? "text-fuchsia-700" : "text-slate-600"}`}>ブロック提案</p>
            <p className={`mt-1 text-xl font-semibold ${blockedProposals > 0 ? "text-fuchsia-900" : "text-slate-900"}`}>{blockedProposals}</p>
          </Link>
          <Link
            href={withWindowParam("/app/proposals?status=proposed", windowFilter)}
            className={`rounded-lg border p-3 ${pendingProposals > 0 ? "border-sky-300 bg-sky-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className={`text-xs ${pendingProposals > 0 ? "text-sky-700" : "text-slate-600"}`}>未判断提案</p>
            <p className={`mt-1 text-xl font-semibold ${pendingProposals > 0 ? "text-sky-900" : "text-slate-900"}`}>{pendingProposals}</p>
          </Link>
          <Link
            href={withWindowParam("/app/cases?status=open", windowFilter)}
            className={`rounded-lg border p-3 ${staleOpenCases > 0 ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className={`text-xs ${staleOpenCases > 0 ? "text-rose-700" : "text-slate-600"}`}>滞留案件 ({staleCaseHours}h+)</p>
            <p className={`mt-1 text-xl font-semibold ${staleOpenCases > 0 ? "text-rose-900" : "text-slate-900"}`}>{staleOpenCases}</p>
            <p className="mt-1 text-[11px] text-slate-600">進行中総数: {openCases}</p>
          </Link>
          <Link
            href={withWindowParam("/app/chat/audit?status=failed", windowFilter)}
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
              チャット失敗({windowLabel})
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
            <p className={`text-xs ${skippedChatCommands > 0 ? "text-amber-700" : "text-slate-600"}`}>チャット スキップ({windowLabel})</p>
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
              高失敗意図（{windowLabel}）
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
                ? `${intentLabel(worstFailedIntent.intentType)} (${worstFailedIntent.failed}/${worstFailedIntent.total})`
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
            チャット失敗ホットスポット: {intentLabel(worstFailedIntent.intentType)} の失敗率が {worstFailedIntent.failureRate}% です。{" "}
            <Link href={worstIntentHref} className="underline">
              失敗一覧で優先対処
            </Link>
            <form action={bulkRetryFailedCommands} className="mt-2 flex flex-wrap items-center gap-2">
              <input type="hidden" name="return_to" value={`/app?window=${windowFilter}`} />
              <input type="hidden" name="scope" value="all" />
              <input type="hidden" name="intent_type" value={worstFailedIntent.intentType} />
              <input type="hidden" name="max_items" value="5" />
              <ConfirmSubmitButton
                label="この意図で再実行確認を一括作成（5件）"
                pendingLabel="確認作成中..."
                confirmMessage={`意図=${intentLabel(worstFailedIntent.intentType)} の失敗コマンドに対して再実行確認を最大5件作成します。実行しますか？`}
                className="rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-800 hover:bg-rose-100"
              />
            </form>
          </div>
        ) : null}
        {nextActions.length > 0 ? (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold text-slate-700">次の対応（優先順）</p>
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
                  <div className="flex items-center gap-2">
                    <Link
                      href={withWindowParam(item.href, windowFilter)}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100"
                    >
                      開く
                    </Link>
                    {item.quickAction === "retry_failed_workflows" ? (
                      <form action={retryTopFailedWorkflowRuns}>
                        <input type="hidden" name="limit" value="3" />
                        <input type="hidden" name="return_to" value={`/app?window=${windowFilter}`} />
                        <ConfirmSubmitButton
                          label="失敗workflow再試行"
                          pendingLabel="再試行中..."
                          confirmMessage="失敗workflow runの上位3件を再試行します。実行しますか？"
                          className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800 hover:bg-amber-100"
                        />
                      </form>
                    ) : null}
                    {item.quickAction === "expire_chat_confirmations" ? (
                      <form action={expireStaleChatConfirmations}>
                        <input type="hidden" name="scope" value="shared" />
                        <input type="hidden" name="return_to" value={`/app?window=${windowFilter}`} />
                        <ConfirmSubmitButton
                          label="期限切れ確認を整理"
                          pendingLabel="整理中..."
                          confirmMessage="チャット確認の期限切れ pending を整理します。実行しますか？"
                          className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-sky-800 hover:bg-sky-100"
                        />
                      </form>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </section>

      <details className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <summary className="cursor-pointer list-none text-sm font-semibold text-slate-900">
          詳細ダッシュボードを表示
        </summary>
        <p className="mt-2 text-xs text-slate-500">改善提案、ステータス分布、全機能ショートカットを表示します。</p>

        <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">AI改善提案（上位）</h2>
            <Link href={withWindowParam("/app/governance/recommendations", windowFilter)} className="text-xs font-medium text-sky-700 hover:text-sky-800">
              すべて見る
            </Link>
          </div>
          {topRecommendations.length > 0 ? (
            <ul className="mt-4 grid gap-3 md:grid-cols-3">
              {topRecommendations.map((item) => (
                <li key={item.id} className="rounded-lg border border-slate-200 bg-white p-3">
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
                    {recommendationPriorityLabel(item.priority)}
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{item.title}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    {recommendationMetricLabel(item.metricLabel)}:{" "}
                    <span className="font-semibold text-slate-700">
                      {recommendationMetricValue(item.metricLabel, item.metricValue)}
                    </span>
                  </p>
                  <p className="mt-2 line-clamp-2 text-xs text-slate-600">{item.description}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-600">改善提案はありません。</p>
          )}
        </section>

        <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">タスクステータス分布</h2>
            <span className="text-xs text-slate-500">0件は棒を表示しません</span>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {taskStatusOrder.map((status) => {
              const count = taskStatusCounts.get(status) ?? 0;
              const heightPct = count > 0 ? Math.max(12, Math.round((count / maxTaskCount) * 100)) : 0;
              return (
                <div key={status} className="rounded-lg border border-slate-100 bg-white p-3">
                  <div className="flex h-36 items-end justify-center rounded-md bg-slate-50 px-2">
                    {count > 0 ? (
                      <div className={`w-10 rounded-t-md ${statusColor(status)}`} style={{ height: `${heightPct}%` }} />
                    ) : null}
                  </div>
                  <p className="mt-2 text-center text-[11px] text-slate-600">{taskStatusLabel(status)}</p>
                  <p className="text-center text-sm font-semibold text-slate-900">{count}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-4">
          <p className="mb-3 text-xs font-semibold text-slate-700">全機能ショートカット</p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
            {links.map((item, idx) => (
              <Link
                key={item.href}
                href={withWindowParam(item.href, windowFilter)}
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
      </details>
    </section>
  );
}
