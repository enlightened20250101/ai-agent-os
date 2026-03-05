import Link from "next/link";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { bulkRetryFailedCommands, expireStaleChatConfirmations, retryChatCommand } from "@/app/app/chat/actions";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type AuditPageProps = {
  searchParams?: Promise<{ status?: string; scope?: string; intent?: string; skip_reason?: string; ok?: string; error?: string }>;
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
  return "border-slate-300 bg-slate-50 text-slate-700";
}

function skipReasonLabel(reason: string) {
  if (reason === "approval_not_pending") return "skip: approval_not_pending";
  if (reason === "approval_already_pending") return "skip: approval_already_pending";
  return `skip: ${reason}`;
}

function skipReasonClass() {
  return "border-amber-300 bg-amber-50 text-amber-800";
}

function buildAuditFilterHref(params: {
  status: string;
  scope: string;
  intent: string;
  skipReason?: string | null;
}) {
  const search = new URLSearchParams();
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.scope && params.scope !== "all") search.set("scope", params.scope);
  if (params.intent && params.intent !== "all") search.set("intent", params.intent);
  if (params.skipReason && params.skipReason !== "all") search.set("skip_reason", params.skipReason);
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
  return "失敗コマンドの result_json を確認し、対象IDを明示した指示へ寄せてください。";
}

export default async function ChatAuditPage({ searchParams }: AuditPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const statusFilter =
    sp.status === "failed" || sp.status === "pending" || sp.status === "running" || sp.status === "done"
      ? sp.status
      : "all";
  const scopeFilter = sp.scope === "shared" || sp.scope === "personal" ? sp.scope : "all";
  const intentFilter = typeof sp.intent === "string" && sp.intent.length > 0 ? sp.intent : "all";
  const skipReasonFilter = typeof sp.skip_reason === "string" && sp.skip_reason.length > 0 ? sp.skip_reason : "all";

  let commandQuery = supabase
    .from("chat_commands")
    .select("id, session_id, intent_id, execution_status, execution_ref_type, execution_ref_id, result_json, created_at, finished_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (statusFilter !== "all") {
    commandQuery = commandQuery.eq("execution_status", statusFilter);
  }
  const { data: commandsData, error: commandsError } = await commandQuery;
  if (commandsError) {
    throw new Error(`Failed to load chat command logs: ${commandsError.message}`);
  }

  const nowIso = new Date().toISOString();
  const [{ count: pendingConfirmations }, { count: overdueConfirmations }] = await Promise.all([
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
      .lt("expires_at", nowIso)
  ]);

  const commands = (commandsData ?? []) as CommandRow[];
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sessionIds = Array.from(new Set(commands.map((row) => row.session_id)));
  const intentIds = Array.from(new Set(commands.map((row) => row.intent_id)));

  let sessionMap = new Map<string, { scope: string; owner: string | null }>();
  if (sessionIds.length > 0) {
    const { data: sessionsData, error: sessionsError } = await supabase
      .from("chat_sessions")
      .select("id, scope, owner_user_id")
      .eq("org_id", orgId)
      .in("id", sessionIds);
    if (sessionsError) {
      throw new Error(`Failed to load chat sessions: ${sessionsError.message}`);
    }
    sessionMap = new Map(
      (sessionsData ?? []).map((row) => [
        row.id as string,
        {
          scope: row.scope as string,
          owner: (row.owner_user_id as string | null) ?? null
        }
      ])
    );
  }

  let intentMap = new Map<string, { intentType: string; summary: string }>();
  if (intentIds.length > 0) {
    const { data: intentsData, error: intentsError } = await supabase
      .from("chat_intents")
      .select("id, intent_type, intent_json")
      .eq("org_id", orgId)
      .in("id", intentIds);
    if (intentsError) {
      throw new Error(`Failed to load chat intents: ${intentsError.message}`);
    }
    intentMap = new Map(
      (intentsData ?? []).map((row) => {
        const intentJson = asObject(row.intent_json);
        return [
          row.id as string,
          {
            intentType: (row.intent_type as string) ?? "unknown",
            summary: typeof intentJson?.summary === "string" ? intentJson.summary : "intent"
          }
        ];
      })
    );
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

  const statusCount = {
    done: rows.filter((row) => row.execution_status === "done").length,
    failed: rows.filter((row) => row.execution_status === "failed").length,
    running: rows.filter((row) => row.execution_status === "running").length,
    pending: rows.filter((row) => row.execution_status === "pending").length
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
    if (!Number.isFinite(createdAtMs) || createdAtMs < sevenDaysAgoMs) continue;
    const result = asObject(row.result_json);
    if (!result || result.skipped !== true) continue;
    const reason = typeof result.skip_reason === "string" && result.skip_reason.length > 0 ? result.skip_reason : "unknown";
    skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);
  }
  const topSkipReasons = Array.from(skipReasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const topSkipReason = topSkipReasons[0]?.[0] ?? null;
  const topSkipRecommendation = topSkipReason ? recommendationForSkipReason(topSkipReason) : null;
  const recommendationHref = buildAuditFilterHref({
    status: statusFilter,
    scope: scopeFilter,
    intent: intentFilter,
    skipReason: topSkipReason
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
  exportParams.set("include_result", "1");
  exportParams.set("limit", "5000");
  const activeFilterSummary = [
    statusFilter !== "all" ? `status=${statusFilter}` : null,
    scopeFilter !== "all" ? `scope=${scopeFilter}` : null,
    intentFilter !== "all" ? `intent=${intentFilter}` : null,
    skipReasonFilter !== "all" ? `skip_reason=${skipReasonFilter}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const hasActiveExportFilters = activeFilterSummary.length > 0;
  const bulkRetryEmphasis = statusFilter === "failed" && statusCount.failed >= 5;
  const currentFilterPath = buildAuditFilterHref({
    status: statusFilter,
    scope: scopeFilter,
    intent: intentFilter,
    skipReason: skipReasonFilter
  });
  const filteredLast7dCount = rows.filter((row) => {
    const createdAtMs = new Date(row.created_at).getTime();
    return Number.isFinite(createdAtMs) && createdAtMs >= sevenDaysAgoMs;
  }).length;
  const totalLast7dCount = commands.filter((row) => {
    const createdAtMs = new Date(row.created_at).getTime();
    return Number.isFinite(createdAtMs) && createdAtMs >= sevenDaysAgoMs;
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
            <input type="hidden" name="return_to" value="/app/chat/audit" />
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
              filtered export
            </span>
          ) : null}
          <CopyFilterLinkButton path={currentFilterPath} />
        </div>
      </header>
      <div className="flex flex-wrap gap-2 text-xs">
        <Link
          href={buildAuditFilterHref({ status: "all", scope: scopeFilter, intent: intentFilter, skipReason: skipReasonFilter })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          status: {statusFilter}
        </Link>
        <Link
          href={buildAuditFilterHref({ status: statusFilter, scope: "all", intent: intentFilter, skipReason: skipReasonFilter })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          scope: {scopeFilter}
        </Link>
        <Link
          href={buildAuditFilterHref({ status: statusFilter, scope: scopeFilter, intent: "all", skipReason: skipReasonFilter })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          intent: {intentFilter}
        </Link>
        <Link
          href={buildAuditFilterHref({ status: statusFilter, scope: scopeFilter, intent: intentFilter, skipReason: "all" })}
          className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          skip_reason: {skipReasonFilter}
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

      {sp.error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p>
      ) : null}
      {sp.ok ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{sp.ok}</p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">done</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{statusCount.done}</p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="text-rose-700">failed</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{statusCount.failed}</p>
        </div>
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm">
          <p className="text-sky-700">running</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{statusCount.running}</p>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-700">pending</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{statusCount.pending}</p>
        </div>
      </div>
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
        <p className="font-medium text-amber-900">skip_reason 上位（7日）</p>
        {topSkipReasons.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {topSkipReasons.map(([reason, count]) => (
              <Link
                key={reason}
                href={buildAuditFilterHref({
                  status: statusFilter,
                  scope: scopeFilter,
                  intent: intentFilter,
                  skipReason: reason
                })}
                className="rounded-full border border-amber-300 bg-white px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
              >
                {reason}: {count}
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-amber-800">直近7日の skip はありません。</p>
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
        <p className="font-medium text-slate-900">intent別失敗率（現在フィルタ）</p>
        {intentPerformance.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {intentPerformance.map((item) => (
              <Link
                key={item.intentType}
                href={buildAuditFilterHref({
                  status: "failed",
                  scope: scopeFilter,
                  intent: item.intentType,
                  skipReason: "all"
                })}
                className={`rounded-full border px-2 py-1 text-xs ${
                  item.failureRate >= 60
                    ? "border-rose-300 bg-rose-50 text-rose-800"
                    : item.failureRate >= 30
                      ? "border-amber-300 bg-amber-50 text-amber-800"
                      : "border-emerald-300 bg-emerald-50 text-emerald-800"
                }`}
              >
                {item.intentType}: {item.failed}/{item.total} ({item.failureRate}%)
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-600">intent別集計対象がありません。</p>
        )}
      </div>
      {worstIntent ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm">
          <p className="font-medium text-rose-900">推奨アクション（intent失敗対策）</p>
          <p className="mt-1 text-xs text-rose-800">
            {worstIntent.intentType} の失敗率が高いです（{worstIntent.failed}/{worstIntent.total}, {worstIntent.failureRate}%）。
            {recommendationForIntentFailure(worstIntent.intentType)}
          </p>
          <Link
            href={buildAuditFilterHref({
              status: "failed",
              scope: scopeFilter,
              intent: worstIntent.intentType,
              skipReason: "all"
            })}
            className="mt-2 inline-block text-xs text-rose-700 underline"
          >
            このintentの failed を開く
          </Link>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-600">確認待ち (all sessions)</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{pendingConfirmations ?? 0}</p>
        </div>
        <div
          className={`rounded-md border p-3 text-sm ${
            (overdueConfirmations ?? 0) > 0 ? "border-rose-300 bg-rose-50" : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <p className={(overdueConfirmations ?? 0) > 0 ? "text-rose-700" : "text-emerald-700"}>期限切れ pending</p>
          <p className={`mt-1 text-2xl font-semibold ${(overdueConfirmations ?? 0) > 0 ? "text-rose-900" : "text-emerald-900"}`}>
            {overdueConfirmations ?? 0}
          </p>
        </div>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
        <label className="flex items-center gap-2">
          status
          <select name="status" defaultValue={statusFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">all</option>
            <option value="failed">failed</option>
            <option value="pending">pending</option>
            <option value="running">running</option>
            <option value="done">done</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          scope
          <select name="scope" defaultValue={scopeFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">all</option>
            <option value="shared">shared</option>
            <option value="personal">personal</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          intent
          <select name="intent" defaultValue={intentFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">all</option>
            {intentOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          skip_reason
          <select name="skip_reason" defaultValue={skipReasonFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1">
            <option value="all">all</option>
            {topSkipReasons.map(([reason]) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
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
        直近7日: <span className="font-semibold text-slate-900">{filteredLast7dCount}</span> /{" "}
        <span className="font-semibold text-slate-900">{totalLast7dCount}</span>
        <span className="mx-2 text-slate-300">|</span>
        比率:{" "}
        <Link
          href={buildAuditFilterHref({
            status: "failed",
            scope: scopeFilter,
            intent: intentFilter,
            skipReason: skipReasonFilter
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
        <input type="hidden" name="return_to" value="/app/chat/audit" />
        <label className="flex items-center gap-1">
          scope
          <select name="scope" defaultValue={scopeFilter === "all" ? "" : scopeFilter} className="rounded-md border border-rose-300 bg-white px-2 py-1">
            <option value="">all</option>
            <option value="shared">shared</option>
            <option value="personal">personal</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          intent
          <select
            name="intent_type"
            defaultValue={intentFilter !== "all" ? intentFilter : worstIntent?.intentType ?? "all"}
            className="rounded-md border border-rose-300 bg-white px-2 py-1"
          >
            <option value="all">all</option>
            {intentOptions.map((option) => (
              <option key={option} value={option}>
                {option}
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
            failed {statusCount.failed}件: 優先実行
          </span>
        ) : null}
        {worstIntent ? (
          <span className="rounded-md border border-rose-300 bg-rose-100 px-2 py-1 font-medium text-rose-800">
            高失敗intent: {worstIntent.intentType}
          </span>
        ) : null}
      </form>

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => {
            const session = sessionMap.get(row.session_id);
            const intent = intentMap.get(row.intent_id);
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
            return (
              <li key={row.id} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded-full border px-2 py-0.5 ${statusBadgeClass(row.execution_status)}`}>
                    {row.execution_status}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                    {session?.scope ?? "unknown"}
                  </span>
                  <span className="text-slate-500">{new Date(row.created_at).toLocaleString()}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                    {intent?.intentType ?? "intent"}
                  </span>
                  {skipped && skipReason ? (
                    <Link
                      href={buildAuditFilterHref({
                        status: statusFilter,
                        scope: scopeFilter,
                        intent: intentFilter,
                        skipReason
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
                        skipReason: skipReasonFilter
                      })}
                      className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-700 hover:bg-violet-100"
                    >
                      quick #{quickIndex} {quickAction}
                    </Link>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-slate-800">{intent?.summary ?? "summaryなし"}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-500">command_id: {row.id}</span>
                  {taskId ? (
                    <Link href={`/app/tasks/${taskId}`} className="text-sky-700 underline">
                      task
                    </Link>
                  ) : null}
                </div>
                {result ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate-600">result_json</summary>
                    <pre className="mt-2 overflow-x-auto rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
                      {JSON.stringify(result, null, 2)}
                    </pre>
                  </details>
                ) : null}
                {row.execution_status === "failed" ? (
                  <form action={retryChatCommand} className="mt-2">
                    <input type="hidden" name="command_id" value={row.id} />
                    <input type="hidden" name="scope" value={session?.scope === "personal" ? "personal" : "shared"} />
                    <input type="hidden" name="return_to" value="/app/chat/audit" />
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
