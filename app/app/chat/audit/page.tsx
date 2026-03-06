import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { bulkRetryFailedCommands, expireStaleChatConfirmations, retryChatCommand } from "@/app/app/chat/actions";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { isMissingChatSchemaError } from "@/lib/chat/schema";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type AuditPageProps = {
  searchParams?: Promise<{
    status?: string;
    scope?: string;
    intent?: string;
    skip_reason?: string;
    ai?: string;
    session_id?: string;
    window?: string;
    ok?: string;
    error?: string;
    ref_job?: string;
    ref_ts?: string;
  }>;
};

type CommandRow = {
  id: string;
  session_id: string;
  intent_id: string;
  execution_status: string;
  execution_ref_type: string | null;
  execution_ref_id: string | null;
  result_json: unknown;
  created_at: string;
  finished_at: string | null;
};

function asObject(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function statusBadgeClass(status: string) {
  if (status === "done") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (status === "running") return "border-sky-300 bg-sky-50 text-sky-800";
  if (status === "pending") return "border-amber-300 bg-amber-50 text-amber-800";
  if (status === "failed") return "border-rose-300 bg-rose-50 text-rose-800";
  if (status === "declined") return "border-slate-400 bg-slate-100 text-slate-800";
  if (status === "skipped") return "border-slate-300 bg-slate-50 text-slate-700";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

function statusLabel(status: string) {
  if (status === "done") return "成功";
  if (status === "running") return "実行中";
  if (status === "pending") return "待機";
  if (status === "failed") return "失敗";
  if (status === "declined") return "却下";
  if (status === "skipped") return "スキップ";
  if (status === "all") return "すべて";
  return status;
}

function scopeLabel(scope: string) {
  if (scope === "shared") return "共有";
  if (scope === "personal") return "個人";
  if (scope === "channel") return "チャンネル";
  if (scope === "all") return "すべて";
  return scope === "unknown" ? "不明" : scope;
}

function aiFilterLabel(value: string) {
  if (value === "mentioned") return "@AIあり";
  if (value === "non_mentioned") return "@AIなし";
  if (value === "all") return "すべて";
  return value;
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

function skipReasonLabel(reason: string) {
  if (reason === "approval_not_pending") return "スキップ: 既に承認待ちではない";
  if (reason === "approval_already_pending") return "スキップ: 承認待ちが既に存在";
  if (reason === "stale_top_candidates") return "スキップ: 候補情報が古い";
  return `スキップ: ${reason}`;
}

function skipReasonClass() {
  return "border-amber-300 bg-amber-50 text-amber-800";
}

function matrixReasonLabel(reason: string) {
  if (reason === "other") return "その他";
  if (reason === "none") return "スキップなし";
  return skipReasonLabel(reason);
}

function quickActionLabel(action: string) {
  if (action === "request_approval") return "承認依頼";
  if (action === "execute_action") return "アクション実行";
  if (action === "run_workflow") return "ワークフロー実行";
  if (action === "run_planner") return "プランナー実行";
  if (action === "bulk_retry_failed_workflows") return "失敗WF一括再試行";
  return action;
}

function getRecoveryPath(value: unknown) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/app/")) return null;
  return value;
}

function withRefContext(path: string, params: { from: string; intent?: string | null; ts?: string | null }) {
  const [base, query = ""] = path.split("?");
  const sp = new URLSearchParams(query);
  sp.set("ref_from", params.from);
  if (params.intent && params.intent.length > 0) {
    sp.set("ref_intent", params.intent);
  }
  if (params.ts && params.ts.length > 0) {
    sp.set("ref_ts", params.ts);
  }
  const qs = sp.toString();
  const withQuery = qs.length > 0 ? `${base}?${qs}` : base;
  return `${withQuery}#ref-target`;
}

function buildAuditFilterHref(params: {
  status: string;
  scope: string;
  intent: string;
  skipReason?: string | null;
  ai?: string | null;
  sessionId?: string | null;
  window?: string | null;
}) {
  const search = new URLSearchParams();
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.scope && params.scope !== "all") search.set("scope", params.scope);
  if (params.intent && params.intent !== "all") search.set("intent", params.intent);
  if (params.skipReason && params.skipReason !== "all") search.set("skip_reason", params.skipReason);
  if (params.ai && params.ai !== "all") search.set("ai", params.ai);
  if (params.sessionId && params.sessionId.length > 0) search.set("session_id", params.sessionId);
  if (params.window && params.window !== "7d") search.set("window", params.window);
  const query = search.toString();
  return query.length > 0 ? `/app/chat/audit?${query}` : "/app/chat/audit";
}

function recommendationForSkipReason(reason: string) {
  const recommendationBase = "/app/chat/audit";
  if (reason === "approval_not_pending") {
    return {
      severity: "medium",
      text: "承認待ちが先に解消されています。実行前に最新状況確認を増やし、並行オペレーションを調整してください。",
      href: recommendationBase
    };
  }
  if (reason === "approval_already_pending") {
    return {
      severity: "low",
      text: "重複承認依頼が発生しています。既存pendingを優先処理し、再依頼は抑制してください。",
      href: recommendationBase
    };
  }
  if (reason === "stale_top_candidates") {
    return {
      severity: "high",
      text: "TOP候補の鮮度切れが多発しています。状況確認を先に再実行し、必要ならTTLを短縮してください。",
      href: recommendationBase
    };
  }
  return {
    severity: "low",
    text: "スキップ理由の詳細を確認し、対象フローの前提条件を見直してください。",
    href: recommendationBase
  };
}

function recommendationForIntentFailure(intentType: string) {
  if (intentType === "request_approval") {
    return "承認依頼前に対象タスクを明示し、必要ならドラフト生成/ポリシー確認を先に実行してください。";
  }
  if (intentType === "execute_action") {
    return "実行前に承認状態と policy_status を確認し、対象タスク名を明示して再実行してください。";
  }
  if (intentType === "quick_top_action") {
    return "TOP候補の鮮度切れが起きやすいため、先に状況確認を再実行してから quick action を使ってください。";
  }
  if (intentType === "run_workflow") {
    return "workflow_template 未設定で失敗しやすいので、/app/tasks でテンプレート設定を確認してください。";
  }
  if (intentType === "bulk_retry_failed_workflows") {
    return "retry exhausted が多い場合は再試行より先に /app/workflows/runs で根本原因を確認してください。";
  }
  return "失敗コマンドの結果JSONを確認し、対象を明示した指示へ寄せてください。";
}

export default async function ChatAuditPage({ searchParams }: AuditPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const statusFilter =
    sp.status === "failed" ||
    sp.status === "pending" ||
    sp.status === "running" ||
    sp.status === "done" ||
    sp.status === "declined" ||
    sp.status === "skipped"
      ? sp.status
      : "all";
  const scopeFilter =
    sp.scope === "shared" || sp.scope === "personal" || sp.scope === "channel" ? sp.scope : "all";
  const intentFilter = typeof sp.intent === "string" && sp.intent.length > 0 ? sp.intent : "all";
  const skipReasonFilter = typeof sp.skip_reason === "string" && sp.skip_reason.length > 0 ? sp.skip_reason : "all";
  const aiFilter = sp.ai === "mentioned" || sp.ai === "non_mentioned" ? sp.ai : "all";
  const sessionIdFilter = typeof sp.session_id === "string" && sp.session_id.trim().length > 0 ? sp.session_id.trim() : "";
  const windowFilter = sp.window === "24h" || sp.window === "30d" ? sp.window : "7d";
  const refJob = typeof sp.ref_job === "string" ? sp.ref_job : "";
  const refTs = typeof sp.ref_ts === "string" ? sp.ref_ts : "";
  const windowHours = windowFilter === "24h" ? 24 : windowFilter === "30d" ? 30 * 24 : 7 * 24;
  const windowLabel = windowFilter === "24h" ? "24時間" : windowFilter === "30d" ? "30日" : "7日";

  let commandQuery = supabase
    .from("chat_commands")
    .select("id, session_id, intent_id, execution_status, execution_ref_type, execution_ref_id, result_json, created_at, finished_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (statusFilter !== "all") {
    commandQuery = commandQuery.eq("execution_status", statusFilter);
  }
  if (sessionIdFilter) {
    commandQuery = commandQuery.eq("session_id", sessionIdFilter);
  }
  const { data: commandsData, error: commandsError } = await commandQuery;
  if (commandsError) {
    if (isMissingChatSchemaError(commandsError.message)) {
      return (
        <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h1 className="text-xl font-semibold text-amber-900">チャット監査</h1>
          <p className="text-sm text-amber-800">
            chat 機能のDB migration（`chat_*` テーブル）が未適用です。`supabase db push` 実行後に監査ログを表示できます。
          </p>
        </section>
      );
    }
    throw new Error(`Failed to load chat command logs: ${commandsError.message}`);
  }

  const nowIso = new Date().toISOString();
  const windowStartMs = Date.now() - windowHours * 60 * 60 * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const [{ count: pendingConfirmations }, { count: overdueConfirmations }, { count: incidentBlockedExecutions }] = await Promise.all([
    supabase
      .from("chat_confirmations")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending"),
    supabase
      .from("chat_confirmations")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending")
      .lt("expires_at", nowIso),
    supabase
      .from("ai_execution_logs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("source", "chat")
      .eq("execution_status", "skipped")
      .eq("metadata_json->>blocked_by_incident", "true")
      .gte("created_at", windowStartIso)
  ]);

  const commands = (commandsData ?? []) as CommandRow[];
  const commandIds = commands.map((row) => row.id).filter(Boolean);
  const sessionIds = Array.from(new Set(commands.map((row) => row.session_id)));
  const intentIds = Array.from(new Set(commands.map((row) => row.intent_id)));
  const executionLogIdByCommandId = new Map<string, string>();

  if (commandIds.length > 0) {
    const oldestCommandCreatedAt =
      commands.length > 0
        ? [...commands]
            .map((row) => row.created_at)
            .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]
        : null;
    let executionLogsQuery = supabase
      .from("ai_execution_logs")
      .select("id, metadata_json, created_at")
      .eq("org_id", orgId)
      .eq("source", "chat")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (oldestCommandCreatedAt) {
      executionLogsQuery = executionLogsQuery.gte("created_at", oldestCommandCreatedAt);
    }
    const { data: executionLogsData, error: executionLogsError } = await executionLogsQuery;
    if (executionLogsError) {
      const missing =
        executionLogsError.message.includes('relation "ai_execution_logs" does not exist') ||
        executionLogsError.message.includes("Could not find the table 'public.ai_execution_logs'");
      if (!missing) {
        throw new Error(`Failed to load execution logs for chat audit: ${executionLogsError.message}`);
      }
    } else {
      const commandIdSet = new Set(commandIds);
      for (const row of executionLogsData ?? []) {
        const payload = asObject(row.metadata_json);
        const commandId = typeof payload?.command_id === "string" ? payload.command_id : null;
        if (commandId && commandIdSet.has(commandId) && !executionLogIdByCommandId.has(commandId)) {
          executionLogIdByCommandId.set(commandId, row.id as string);
        }
      }
    }
  }

  let sessionMap = new Map<string, { scope: string; owner: string | null; channelId: string | null }>();
  if (sessionIds.length > 0) {
    const { data: sessionsData, error: sessionsError } = await supabase
      .from("chat_sessions")
      .select("id, scope, owner_user_id, channel_id")
      .eq("org_id", orgId)
      .in("id", sessionIds);
    if (sessionsError) {
      if (isMissingChatSchemaError(sessionsError.message)) {
        return (
          <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-6">
            <h1 className="text-xl font-semibold text-amber-900">チャット監査</h1>
            <p className="text-sm text-amber-800">
              chat session テーブルが未適用です。`supabase db push` 実行後に監査ログを表示できます。
            </p>
          </section>
        );
      }
      throw new Error(`Failed to load chat sessions: ${sessionsError.message}`);
    }
    sessionMap = new Map(
      (sessionsData ?? []).map((row) => [
        row.id as string,
        {
          scope: row.scope as string,
          owner: (row.owner_user_id as string | null) ?? null,
          channelId: (row.channel_id as string | null) ?? null
        }
      ])
    );
  }

  let intentMap = new Map<string, { intentType: string; summary: string; messageId: string | null }>();
  if (intentIds.length > 0) {
    const { data: intentsData, error: intentsError } = await supabase
      .from("chat_intents")
      .select("id, intent_type, intent_json, message_id")
      .eq("org_id", orgId)
      .in("id", intentIds);
    if (intentsError) {
      if (isMissingChatSchemaError(intentsError.message)) {
        return (
          <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-6">
            <h1 className="text-xl font-semibold text-amber-900">チャット監査</h1>
            <p className="text-sm text-amber-800">
              chat intent テーブルが未適用です。`supabase db push` 実行後に監査ログを表示できます。
            </p>
          </section>
        );
      }
      throw new Error(`Failed to load chat intents: ${intentsError.message}`);
    }
    intentMap = new Map(
      (intentsData ?? []).map((row) => {
        const intentJson = asObject(row.intent_json);
        return [
          row.id as string,
          {
            intentType: (row.intent_type as string) ?? "unknown",
            summary: typeof intentJson?.summary === "string" ? intentJson.summary : "intent",
            messageId: (row.message_id as string | null) ?? null
          }
        ];
      })
    );
  }

  const messageIds = Array.from(
    new Set(Array.from(intentMap.values()).map((row) => row.messageId).filter((v): v is string => Boolean(v)))
  );
  const messageMetaById = new Map<string, { aiMentioned: boolean; mentions: string[] }>();
  if (messageIds.length > 0) {
    const { data: messagesData, error: messagesError } = await supabase
      .from("chat_messages")
      .select("id, metadata_json")
      .eq("org_id", orgId)
      .in("id", messageIds);
    if (messagesError) {
      if (isMissingChatSchemaError(messagesError.message)) {
        return (
          <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-6">
            <h1 className="text-xl font-semibold text-amber-900">チャット監査</h1>
            <p className="text-sm text-amber-800">
              chat message テーブルが未適用です。`supabase db push` 実行後に監査ログを表示できます。
            </p>
          </section>
        );
      }
      throw new Error(`Failed to load chat messages: ${messagesError.message}`);
    }
    for (const row of messagesData ?? []) {
      const metadata = asObject(row.metadata_json);
      const mentions = Array.isArray(metadata?.mentions)
        ? metadata.mentions.filter((item): item is string => typeof item === "string")
        : [];
      messageMetaById.set(row.id as string, {
        aiMentioned: metadata?.ai_mentioned === true,
        mentions
      });
    }
  }

  let rows = commands;
  if (scopeFilter !== "all") {
    rows = rows.filter((row) => sessionMap.get(row.session_id)?.scope === scopeFilter);
  }
  if (intentFilter !== "all") {
    rows = rows.filter((row) => intentMap.get(row.intent_id)?.intentType === intentFilter);
  }
  if (skipReasonFilter !== "all") {
    rows = rows.filter((row) => {
      const result = asObject(row.result_json);
      return result?.skipped === true && result?.skip_reason === skipReasonFilter;
    });
  }
  if (aiFilter !== "all") {
    rows = rows.filter((row) => {
      const messageId = intentMap.get(row.intent_id)?.messageId ?? null;
      const aiMentioned = messageId ? (messageMetaById.get(messageId)?.aiMentioned ?? false) : false;
      return aiFilter === "mentioned" ? aiMentioned : !aiMentioned;
    });
  }
  if (sessionIdFilter) {
    rows = rows.filter((row) => row.session_id === sessionIdFilter);
  }

  const statusCount = {
    done: rows.filter((row) => row.execution_status === "done").length,
    failed: rows.filter((row) => row.execution_status === "failed").length,
    running: rows.filter((row) => row.execution_status === "running").length,
    pending: rows.filter((row) => row.execution_status === "pending").length,
    declined: rows.filter((row) => row.execution_status === "declined").length,
    skipped: rows.filter((row) => row.execution_status === "skipped").length
  };
  const intentPerformance = Array.from(
    rows.reduce((acc, row) => {
      const intentType = intentMap.get(row.intent_id)?.intentType ?? "unknown";
      const current = acc.get(intentType) ?? { intentType, total: 0, failed: 0 };
      current.total += 1;
      if (row.execution_status === "failed") current.failed += 1;
      acc.set(intentType, current);
      return acc;
    }, new Map<string, { intentType: string; total: number; failed: number }>())
      .values()
  )
    .map((row) => ({
      ...row,
      failureRate: row.total > 0 ? Math.round((row.failed / row.total) * 100) : 0
    }))
    .sort((a, b) => {
      if (b.failureRate !== a.failureRate) return b.failureRate - a.failureRate;
      if (b.failed !== a.failed) return b.failed - a.failed;
      return b.total - a.total;
    })
    .slice(0, 6);
  const worstIntent = intentPerformance.find((row) => row.total >= 3 && row.failureRate >= 50) ?? null;
  const skipReasonCounts = new Map<string, number>();
  for (const row of rows) {
    const createdAtMs = new Date(row.created_at).getTime();
    if (!Number.isFinite(createdAtMs) || createdAtMs < windowStartMs) continue;
    const result = asObject(row.result_json);
    if (!result || result.skipped !== true) continue;
    const reason = typeof result.skip_reason === "string" && result.skip_reason.length > 0 ? result.skip_reason : "unknown";
    skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);
  }
  const topSkipReasons = Array.from(skipReasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const topIntentTypesForMatrix = Array.from(
    rows.reduce((acc, row) => {
      const intentType = intentMap.get(row.intent_id)?.intentType ?? "unknown";
      acc.set(intentType, (acc.get(intentType) ?? 0) + 1);
      return acc;
    }, new Map<string, number>())
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([intentType]) => intentType);
  const topSkipReasonsForMatrix = topSkipReasons.map(([reason]) => reason).slice(0, 5);
  const matrixCells = new Map<string, number>();
  const matrixIncidentBlockedByIntent = new Map<string, number>();
  for (const row of rows) {
    const intentType = intentMap.get(row.intent_id)?.intentType ?? "unknown";
    if (!topIntentTypesForMatrix.includes(intentType)) continue;
    const result = asObject(row.result_json);
    const skipReason =
      result?.skipped === true && typeof result?.skip_reason === "string"
        ? result.skip_reason
        : "none";
    const reasonKey = topSkipReasonsForMatrix.includes(skipReason) ? skipReason : "other";
    const key = `${intentType}::${reasonKey}`;
    matrixCells.set(key, (matrixCells.get(key) ?? 0) + 1);
    if (result?.blocked_by_incident === true) {
      matrixIncidentBlockedByIntent.set(
        intentType,
        (matrixIncidentBlockedByIntent.get(intentType) ?? 0) + 1
      );
    }
  }
  const matrixColumns = [...topSkipReasonsForMatrix, "other"];
  const topSkipReason = topSkipReasons[0]?.[0] ?? null;
  const topSkipRecommendation = topSkipReason ? recommendationForSkipReason(topSkipReason) : null;
  const recommendationHref = buildAuditFilterHref({
    status: statusFilter,
    scope: scopeFilter,
    intent: intentFilter,
    skipReason: topSkipReason,
    ai: aiFilter,
    sessionId: sessionIdFilter || null,
    window: windowFilter
  });

  const intentOptions = Array.from(
    new Set(
      Array.from(intentMap.values())
        .map((v) => v.intentType)
        .filter(Boolean)
    )
  ).sort();
  const exportParams = new URLSearchParams();
  exportParams.set("status", statusFilter);
  exportParams.set("scope", scopeFilter);
  exportParams.set("intent", intentFilter);
  exportParams.set("skip_reason", skipReasonFilter);
  exportParams.set("ai", aiFilter);
  if (sessionIdFilter) exportParams.set("session_id", sessionIdFilter);
  exportParams.set("window", windowFilter);
  exportParams.set("include_result", "1");
  exportParams.set("limit", "5000");
  const activeFilterSummary = [
    statusFilter !== "all" ? `状態=${statusLabel(statusFilter)}` : null,
    scopeFilter !== "all" ? `範囲=${scopeLabel(scopeFilter)}` : null,
    intentFilter !== "all" ? `意図=${intentLabel(intentFilter)}` : null,
    skipReasonFilter !== "all" ? `スキップ理由=${skipReasonLabel(skipReasonFilter)}` : null,
    aiFilter !== "all" ? `AI=${aiFilterLabel(aiFilter)}` : null,
    sessionIdFilter ? `セッション=${sessionIdFilter}` : null,
    windowFilter !== "7d" ? `期間=${windowLabel}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const hasActiveExportFilters = activeFilterSummary.length > 0;
  const bulkRetryEmphasis = statusFilter === "failed" && statusCount.failed >= 5;
  const currentFilterPath = buildAuditFilterHref({
    status: statusFilter,
    scope: scopeFilter,
    intent: intentFilter,
    skipReason: skipReasonFilter,
    ai: aiFilter,
    sessionId: sessionIdFilter || null,
    window: windowFilter
  });
  const filteredLast7dCount = rows.filter((row) => {
    const createdAtMs = new Date(row.created_at).getTime();
    return Number.isFinite(createdAtMs) && createdAtMs >= windowStartMs;
  }).length;
  const totalLast7dCount = commands.filter((row) => {
    const createdAtMs = new Date(row.created_at).getTime();
    return Number.isFinite(createdAtMs) && createdAtMs >= windowStartMs;
  }).length;
  const filteredLast7dRatio = totalLast7dCount > 0 ? Math.round((filteredLast7dCount / totalLast7dCount) * 100) : 0;
  const ratioClass =
    filteredLast7dRatio >= 80
      ? "text-rose-800"
      : filteredLast7dRatio >= 50
        ? "text-amber-800"
        : "text-emerald-800";
  const ratioBadgeClass =
    filteredLast7dRatio >= 80
      ? "border-rose-300 bg-rose-50"
      : filteredLast7dRatio >= 50
        ? "border-amber-300 bg-amber-50"
        : "border-emerald-300 bg-emerald-50";

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">チャット監査ログ</h1>
          <p className="mt-2 text-sm text-slate-600">
            共有/個人チャットのコマンド実行履歴です。個人チャットはRLSにより本人分のみ表示されます。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <form action={expireStaleChatConfirmations}>
            <input type="hidden" name="scope" value="shared" />
            <input type="hidden" name="return_to" value={currentFilterPath} />
            <ConfirmSubmitButton
              label="期限切れ確認を整理"
              pendingLabel="整理中..."
              confirmMessage="期限切れ pending 確認を整理します。実行しますか？"
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800"
            />
          </form>
          <Link href="/app/chat/shared" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700">
            共有チャット
          </Link>
          <Link href="/app/chat/me" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700">
            個人チャット
          </Link>
          <Link
            href={`/api/chat/audit/export?${exportParams.toString()}&format=csv`}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700"
          >
            CSV出力
          </Link>
          <Link
            href={`/api/chat/audit/export?${exportParams.toString()}&format=json`}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700"
          >
            JSON出力
          </Link>
          {hasActiveExportFilters ? (
            <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">
              条件付きエクスポート
            </span>
          ) : null}
          <CopyFilterLinkButton path={currentFilterPath} />
        </div>
      </header>
      <div className="flex flex-wrap gap-2 text-xs">
        <Link
          href={buildAuditFilterHref({
            status: "all",
            scope: scopeFilter,
            intent: intentFilter,
            skipReason: skipReasonFilter,
            ai: aiFilter,
            sessionId: sessionIdFilter || null,
            window: windowFilter
          })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          状態: {statusLabel(statusFilter)}
        </Link>
        <Link
          href={buildAuditFilterHref({
            status: statusFilter,
            scope: "all",
            intent: intentFilter,
            skipReason: skipReasonFilter,
            ai: aiFilter,
            sessionId: sessionIdFilter || null,
            window: windowFilter
          })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          範囲: {scopeLabel(scopeFilter)}
        </Link>
        <Link
          href={buildAuditFilterHref({
            status: statusFilter,
            scope: scopeFilter,
            intent: "all",
            skipReason: skipReasonFilter,
            ai: aiFilter,
            sessionId: sessionIdFilter || null,
            window: windowFilter
          })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          意図: {intentFilter === "all" ? "すべて" : intentLabel(intentFilter)}
        </Link>
        <Link
          href={buildAuditFilterHref({
            status: statusFilter,
            scope: scopeFilter,
            intent: intentFilter,
            skipReason: "all",
            ai: aiFilter,
            sessionId: sessionIdFilter || null,
            window: windowFilter
          })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          スキップ理由: {skipReasonFilter === "all" ? "すべて" : skipReasonLabel(skipReasonFilter)}
        </Link>
        <Link
          href={buildAuditFilterHref({
            status: statusFilter,
            scope: scopeFilter,
            intent: intentFilter,
            skipReason: skipReasonFilter,
            ai: "all",
            sessionId: sessionIdFilter || null,
            window: windowFilter
          })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          AI: {aiFilterLabel(aiFilter)}
        </Link>
        <Link
          href={buildAuditFilterHref({
            status: statusFilter,
            scope: scopeFilter,
            intent: intentFilter,
            skipReason: skipReasonFilter,
            ai: aiFilter,
            sessionId: sessionIdFilter || null,
            window: "7d"
          })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          期間: {windowLabel}
        </Link>
        {statusFilter === "failed" ? (
          <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-1 font-semibold text-rose-700">
            高優先トリアージ中
          </span>
        ) : null}
      </div>
      {hasActiveExportFilters ? (
        <p className="text-xs text-slate-500">エクスポート条件: {activeFilterSummary}</p>
      ) : null}
      {sessionIdFilter ? (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          セッション固定表示中: {sessionIdFilter}
        </div>
      ) : null}
      {refJob || refTs ? (
        <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
          参照コンテキスト: {refJob || "manual"} {refTs ? `(${new Date(refTs).toLocaleString("ja-JP")})` : ""}
        </div>
      ) : null}

      {sp.error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p>
      ) : null}
      {sp.ok ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{sp.ok}</p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-6">
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">成功</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{statusCount.done}</p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="text-rose-700">失敗</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{statusCount.failed}</p>
        </div>
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm">
          <p className="text-sky-700">実行中</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{statusCount.running}</p>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">待機</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{statusCount.pending}</p>
        </div>
        <div className="rounded-md border border-slate-300 bg-slate-50 p-3 text-sm">
          <p className="text-slate-700">却下</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{statusCount.declined}</p>
        </div>
        <div className="rounded-md border border-slate-300 bg-slate-50 p-3 text-sm">
          <p className="text-slate-700">スキップ</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{statusCount.skipped}</p>
        </div>
      </div>
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
        <p className="font-medium text-amber-900">スキップ理由 上位（{windowLabel}）</p>
        {topSkipReasons.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {topSkipReasons.map(([reason, count]) => (
              <Link
                key={reason}
                href={buildAuditFilterHref({
                  status: statusFilter,
                  scope: scopeFilter,
                  intent: intentFilter,
                  skipReason: reason,
                  ai: aiFilter,
                  sessionId: sessionIdFilter || null,
                  window: windowFilter
                })}
                className="rounded-full border border-amber-300 bg-white px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
              >
                {skipReasonLabel(reason)}: {count}
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-amber-800">直近{windowLabel}の skip はありません。</p>
        )}
      </div>
      {topSkipRecommendation ? (
        <div
          className={`rounded-md border p-3 text-sm ${
            topSkipRecommendation.severity === "high"
              ? "border-rose-300 bg-rose-50"
              : topSkipRecommendation.severity === "medium"
                ? "border-amber-300 bg-amber-50"
                : "border-sky-300 bg-sky-50"
          }`}
        >
          <p className="font-medium text-slate-900">推奨アクション（skip対策）</p>
          <p className="mt-1 text-xs text-slate-700">{topSkipRecommendation.text}</p>
          <Link href={recommendationHref} className="mt-2 inline-block text-xs text-sky-700 underline">
            対応ページを開く
          </Link>
        </div>
      ) : null}
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
        <p className="font-medium text-slate-900">意図別失敗率（現在フィルタ）</p>
        {intentPerformance.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {intentPerformance.map((item) => (
              <Link
                key={item.intentType}
                href={buildAuditFilterHref({
                  status: "failed",
                  scope: scopeFilter,
                  intent: item.intentType,
                  skipReason: "all",
                  ai: aiFilter,
                  sessionId: sessionIdFilter || null,
                  window: windowFilter
                })}
                className={`rounded-full border px-2 py-1 text-xs ${
                  item.failureRate >= 60
                    ? "border-rose-300 bg-rose-50 text-rose-800"
                    : item.failureRate >= 30
                      ? "border-amber-300 bg-amber-50 text-amber-800"
                      : "border-emerald-300 bg-emerald-50 text-emerald-800"
                }`}
              >
                {intentLabel(item.intentType)}: {item.failed}/{item.total} ({item.failureRate}%)
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-600">意図別の集計対象がありません。</p>
        )}
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-3 text-sm">
        <p className="font-medium text-slate-900">詰まりマトリクス（意図 × スキップ理由）</p>
        {topIntentTypesForMatrix.length > 0 ? (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="px-2 py-1">意図</th>
                  {matrixColumns.map((col) => (
                    <th key={col} className="px-2 py-1">
                      {matrixReasonLabel(col)}
                    </th>
                  ))}
                  <th className="px-2 py-1">インシデント停止</th>
                </tr>
              </thead>
              <tbody>
                {topIntentTypesForMatrix.map((intentType) => (
                  <tr key={intentType} className="border-b border-slate-100">
                    <td className="px-2 py-1 font-medium text-slate-700">{intentLabel(intentType)}</td>
                    {matrixColumns.map((col) => {
                      const value = matrixCells.get(`${intentType}::${col}`) ?? 0;
                      const href = buildAuditFilterHref({
                        status: "all",
                        scope: scopeFilter,
                        intent: intentType,
                        skipReason: col === "other" ? "all" : col,
                        ai: aiFilter,
                        sessionId: sessionIdFilter || null,
                        window: windowFilter
                      });
                      return (
                        <td key={`${intentType}-${col}`} className="px-2 py-1 text-slate-700">
                          {value > 0 ? (
                            <Link href={href} className="font-medium text-sky-700 underline">
                              {value}
                            </Link>
                          ) : (
                            "0"
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1 text-rose-700">
                      {(() => {
                        const count = matrixIncidentBlockedByIntent.get(intentType) ?? 0;
                        const href = buildAuditFilterHref({
                          status: "all",
                          scope: scopeFilter,
                          intent: intentType,
                          skipReason: "all",
                          ai: aiFilter,
                          sessionId: sessionIdFilter || null,
                          window: windowFilter
                        });
                        return count > 0 ? (
                          <Link href={href} className="font-medium text-rose-700 underline">
                            {count}
                          </Link>
                        ) : (
                          "0"
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-600">集計対象がありません。</p>
        )}
      </div>
      {worstIntent ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm">
          <p className="font-medium text-rose-900">推奨アクション（意図別失敗対策）</p>
          <p className="mt-1 text-xs text-rose-800">
            {intentLabel(worstIntent.intentType)} の失敗率が高いです（{worstIntent.failed}/{worstIntent.total}, {worstIntent.failureRate}%）。
            {recommendationForIntentFailure(worstIntent.intentType)}
          </p>
          <Link
            href={buildAuditFilterHref({
              status: "failed",
              scope: scopeFilter,
              intent: worstIntent.intentType,
              skipReason: "all",
              ai: aiFilter,
              sessionId: sessionIdFilter || null,
              window: windowFilter
            })}
            className="mt-2 inline-block text-xs text-rose-700 underline"
          >
            この意図の失敗ログを開く
          </Link>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-600">確認待ち（全セッション）</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{pendingConfirmations ?? 0}</p>
        </div>
        <div
          className={`rounded-md border p-3 text-sm ${
            (overdueConfirmations ?? 0) > 0 ? "border-rose-300 bg-rose-50" : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <p className={(overdueConfirmations ?? 0) > 0 ? "text-rose-700" : "text-emerald-700"}>期限切れ確認待ち</p>
          <p className={`mt-1 text-2xl font-semibold ${(overdueConfirmations ?? 0) > 0 ? "text-rose-900" : "text-emerald-900"}`}>
            {overdueConfirmations ?? 0}
          </p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="text-rose-700">インシデント停止 ({windowLabel})</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{incidentBlockedExecutions ?? 0}</p>
        </div>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
        <label className="flex items-center gap-2">
          状態
          <select name="status" defaultValue={statusFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">すべて</option>
            <option value="failed">失敗</option>
            <option value="pending">待機</option>
            <option value="running">実行中</option>
            <option value="done">成功</option>
            <option value="declined">却下</option>
            <option value="skipped">スキップ</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          範囲
          <select name="scope" defaultValue={scopeFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">すべて</option>
            <option value="shared">共有</option>
            <option value="personal">個人</option>
            <option value="channel">チャンネル</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          意図
          <select name="intent" defaultValue={intentFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">すべて</option>
            {intentOptions.map((option) => (
              <option key={option} value={option}>
                {intentLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          スキップ理由
          <select name="skip_reason" defaultValue={skipReasonFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">すべて</option>
            {topSkipReasons.map(([reason]) => (
              <option key={reason} value={reason}>
                {skipReasonLabel(reason)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          AI
          <select name="ai" defaultValue={aiFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">すべて</option>
            <option value="mentioned">@AIあり</option>
            <option value="non_mentioned">@AIなし</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          セッションID
          <input
            type="text"
            name="session_id"
            defaultValue={sessionIdFilter}
            placeholder="session_id"
            className="w-52 rounded-md border border-slate-300 bg-white px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          期間
          <select name="window" defaultValue={windowFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="24h">24時間</option>
            <option value="7d">7日</option>
            <option value="30d">30日</option>
          </select>
        </label>
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-2 py-1">
          絞り込み
        </button>
        <Link href="/app/chat/audit" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100">
          フィルタをリセット
        </Link>
      </form>
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
        表示件数: <span className="font-semibold text-slate-900">{rows.length}</span> / 全件{" "}
        <span className="font-semibold text-slate-900">{commands.length}</span>
        <span className="mx-2 text-slate-300">|</span>
        直近{windowLabel}: <span className="font-semibold text-slate-900">{filteredLast7dCount}</span> /{" "}
        <span className="font-semibold text-slate-900">{totalLast7dCount}</span>
        <span className="mx-2 text-slate-300">|</span>
        比率:{" "}
        <Link
          href={buildAuditFilterHref({
            status: "failed",
            scope: scopeFilter,
            intent: intentFilter,
            skipReason: skipReasonFilter,
            ai: aiFilter,
            sessionId: sessionIdFilter || null,
            window: windowFilter
          })}
          className={`rounded-full border px-2 py-0.5 font-semibold hover:brightness-95 ${ratioClass} ${ratioBadgeClass}`}
        >
          {filteredLast7dRatio}%
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span>この条件で開く:</span>
        <Link href={currentFilterPath} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sky-700 hover:bg-sky-50">
          {currentFilterPath}
        </Link>
      </div>
      <form action={bulkRetryFailedCommands} className="flex flex-wrap items-center gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs">
        <p className="font-medium text-rose-900">失敗コマンドの再実行確認を一括作成</p>
        <input type="hidden" name="return_to" value={currentFilterPath} />
        <label className="flex items-center gap-1">
          範囲
          <select name="scope" defaultValue={scopeFilter === "all" ? "" : scopeFilter} className="rounded-md border border-rose-300 bg-white px-2 py-1">
            <option value="">すべて</option>
            <option value="shared">共有</option>
            <option value="personal">個人</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          意図
          <select
            name="intent_type"
            defaultValue={intentFilter !== "all" ? intentFilter : worstIntent?.intentType ?? "all"}
            className="rounded-md border border-rose-300 bg-white px-2 py-1"
          >
            <option value="all">すべて</option>
            {intentOptions.map((option) => (
              <option key={option} value={option}>
                {intentLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          件数
          <input
            type="number"
            name="max_items"
            min={1}
            max={20}
            defaultValue={statusFilter === "failed" ? 10 : 5}
            className="w-16 rounded-md border border-rose-300 bg-white px-2 py-1"
          />
        </label>
        <ConfirmSubmitButton
          label={bulkRetryEmphasis ? "優先: 一括で確認作成" : "一括で確認作成"}
          pendingLabel="確認作成中..."
          confirmMessage="現在の条件で失敗コマンドの再実行確認を一括作成します。実行しますか？"
          className={`rounded-md border px-2 py-1 ${
            bulkRetryEmphasis
              ? "border-rose-500 bg-rose-600 font-semibold text-white hover:bg-rose-500"
              : "border-rose-300 bg-white text-rose-700 hover:bg-rose-100"
          }`}
        />
        {bulkRetryEmphasis ? (
          <span className="rounded-md border border-rose-300 bg-rose-100 px-2 py-1 font-medium text-rose-800">
            失敗 {statusCount.failed}件: 優先実行
          </span>
        ) : null}
        {worstIntent ? (
          <span className="rounded-md border border-rose-300 bg-rose-100 px-2 py-1 font-medium text-rose-800">
            高失敗意図: {intentLabel(worstIntent.intentType)}
          </span>
        ) : null}
      </form>

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => {
            const session = sessionMap.get(row.session_id);
            const intent = intentMap.get(row.intent_id);
            const messageMeta = intent?.messageId ? messageMetaById.get(intent.messageId) : null;
            const result = asObject(row.result_json);
            const skipped = result?.skipped === true;
            const skipReason = typeof result?.skip_reason === "string" ? result.skip_reason : null;
            const quickRef = asObject(result?.quick_ref);
            const quickIndex = typeof quickRef?.index === "number" ? quickRef.index : null;
            const quickAction = typeof quickRef?.requested_action === "string" ? quickRef.requested_action : null;
            const taskId =
              typeof result?.task_id === "string"
                ? result.task_id
                : row.execution_ref_type === "task"
                  ? row.execution_ref_id
                  : null;
            const executionLogId = executionLogIdByCommandId.get(row.id) ?? null;
            const recoveryPath = getRecoveryPath(result?.recovery_path);
            const matchesRefTs =
              Boolean(refTs) && new Date(row.created_at).toISOString() === new Date(refTs).toISOString();
            const fallbackWorkflowRef =
              !matchesRefTs &&
              refJob === "workflow_tick" &&
              (row.execution_status === "failed" || (result?.blocked_by_incident as boolean | undefined) === true);
            const isHighlighted = matchesRefTs || fallbackWorkflowRef;
            const recoveryHref = recoveryPath
              ? withRefContext(recoveryPath, {
                  from: "chat_audit",
                  intent: intent?.intentType ?? null,
                  ts: row.created_at
                })
              : null;
            return (
              <li
                key={row.id}
                className={`rounded-lg border bg-white p-3 ${isHighlighted ? "border-indigo-300 bg-indigo-50/40 ring-1 ring-indigo-200" : "border-slate-200"}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded-full border px-2 py-0.5 ${statusBadgeClass(row.execution_status)}`}>
                    {statusLabel(row.execution_status)}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                    {scopeLabel(session?.scope ?? "unknown")}
                  </span>
                  <span className="text-slate-500">{new Date(row.created_at).toLocaleString("ja-JP")}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                    {intentLabel(intent?.intentType ?? "不明")}
                  </span>
                  {messageMeta?.aiMentioned ? (
                    <span className="rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-sky-800">@AI</span>
                  ) : (
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-500">@AIなし</span>
                  )}
                  {result?.blocked_by_incident === true ? (
                    <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-rose-800">
                      インシデント停止
                    </span>
                  ) : null}
                  {skipped && skipReason ? (
                    <Link
                      href={buildAuditFilterHref({
                        status: statusFilter,
                        scope: scopeFilter,
                        intent: intentFilter,
                        skipReason,
                        ai: aiFilter,
                        sessionId: sessionIdFilter || null,
                        window: windowFilter
                      })}
                      className={`rounded-full border px-2 py-0.5 hover:bg-amber-100 ${skipReasonClass()}`}
                    >
                      {skipReasonLabel(skipReason)}
                    </Link>
                  ) : null}
                  {quickIndex && quickAction ? (
                    <Link
                      href={buildAuditFilterHref({
                        status: statusFilter,
                        scope: scopeFilter,
                        intent: "quick_top_action",
                        skipReason: skipReasonFilter,
                        ai: aiFilter,
                        sessionId: sessionIdFilter || null,
                        window: windowFilter
                      })}
                    className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-700 hover:bg-violet-100"
                  >
                      クイック #{quickIndex} {quickActionLabel(quickAction)}
                    </Link>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-slate-800">{intent?.summary ?? "要約なし"}</p>
                {messageMeta && messageMeta.mentions.length > 0 ? (
                  <p className="mt-1 text-xs text-slate-500">メンション: {messageMeta.mentions.join(", ")}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {recoveryHref ? (
                    <Link href={recoveryHref} className="text-rose-700 underline">
                      復旧先を開く
                    </Link>
                  ) : null}
                  {executionLogId ? (
                    <Link href={`/app/executions/${executionLogId}`} className="text-slate-700 underline">
                      実行履歴詳細
                    </Link>
                  ) : null}
                  {taskId ? (
                    <Link href={`/app/tasks/${taskId}`} className="text-sky-700 underline">
                      タスク
                    </Link>
                  ) : null}
                  {taskId ? (
                    <Link href={`/app/tasks/${taskId}/evidence`} className="text-indigo-700 underline">
                      証跡
                    </Link>
                  ) : null}
                  {session?.scope === "channel" && session.channelId ? (
                    <Link href={`/app/chat/channels/${session.channelId}`} className="text-violet-700 underline">
                      チャンネル
                    </Link>
                  ) : null}
                </div>
                {result ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate-600">結果JSON</summary>
                    <pre className="mt-2 overflow-x-auto rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
                      {toRedactedJson(result)}
                    </pre>
                  </details>
                ) : null}
                {row.execution_status === "failed" ? (
                  <form action={retryChatCommand} className="mt-2">
                    <input type="hidden" name="command_id" value={row.id} />
                    <input
                      type="hidden"
                      name="scope"
                      value={
                        session?.scope === "personal"
                          ? "personal"
                          : session?.scope === "channel"
                            ? "channel"
                            : "shared"
                      }
                    />
                    {session?.scope === "channel" && session.channelId ? (
                      <input type="hidden" name="channel_id" value={session.channelId} />
                    ) : null}
                    <input type="hidden" name="return_to" value={currentFilterPath} />
                    <ConfirmSubmitButton
                      label="再実行確認を作成"
                      pendingLabel="作成中..."
                      confirmMessage="この失敗コマンドの再実行確認を作成します。実行しますか？"
                      className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
                    />
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">表示対象のコマンドはありません。</p>
      )}
    </section>
  );
}
