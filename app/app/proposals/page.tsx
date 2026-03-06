import Link from "next/link";
import { CopyFilterLinkButton } from "@/app/app/chat/audit/CopyFilterLinkButton";
import { acceptProposal, bulkRejectProposals, rejectProposal } from "@/app/app/proposals/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { toRedactedJson } from "@/lib/ui/redactIds";

export const dynamic = "force-dynamic";

type ProposalsPageProps = {
  searchParams?: Promise<{
    status?: string;
    policy_status?: string;
    source?: string;
    min_priority?: string;
    decision_reason_prefix?: string;
    ok?: string;
    error?: string;
  }>;
};

function parseActions(payload: unknown) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item) => (typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null))
    .filter((v): v is Record<string, unknown> => v !== null);
}

function parseStringList(payload: unknown) {
  return Array.isArray(payload) ? payload.filter((item): item is string => typeof item === "string") : [];
}

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

function decisionReasonPrefix(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return "unspecified";
  const idx = value.indexOf(":");
  return (idx >= 0 ? value.slice(0, idx) : value).trim() || "unspecified";
}

function policyStatusLabel(value: string) {
  if (value === "pass") return "許可";
  if (value === "warn") return "注意";
  if (value === "block") return "ブロック";
  return value;
}

function proposalStatusLabel(value: string) {
  if (value === "proposed") return "提案中";
  if (value === "accepted") return "受け入れ済み";
  if (value === "rejected") return "却下済み";
  if (value === "executed") return "実行済み";
  return value;
}

function sourceLabel(value: string) {
  if (value === "manual") return "手動";
  if (value === "planner") return "プランナー";
  if (value.startsWith("planner_seed_external_event_")) return "プランナー（外部イベント）";
  if (value === "planner_seed_case_stale") return "プランナー（滞留案件）";
  if (value === "planner_seed_action_failed") return "プランナー（実行失敗）";
  if (value === "planner_seed_pending_approval") return "プランナー（承認滞留）";
  if (value === "planner_seed_policy_warn") return "プランナー（ポリシー警告）";
  return value;
}

function reasonCodeLabel(value: string) {
  if (value === "accepted_low_risk") return "受け入れ（低リスク）";
  if (value === "accepted_manual") return "受け入れ（手動判断）";
  if (value === "accepted_after_review") return "受け入れ（レビュー後）";
  if (value === "rejected_low_value") return "却下（優先度低）";
  if (value === "rejected_policy") return "却下（ポリシー）";
  if (value === "rejected_duplicate") return "却下（重複）";
  if (value === "rejected_scope") return "却下（範囲外）";
  if (value === "rejected_other") return "却下（その他）";
  if (value === "unspecified") return "未指定";
  return value;
}

export default async function ProposalsPage({ searchParams }: ProposalsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  let query = supabase
    .from("task_proposals")
    .select(
      "id, source, title, rationale, proposed_actions_json, risks_json, policy_status, policy_reasons, priority_score, estimated_impact_json, status, decision_reason, created_at, decided_at"
    )
    .eq("org_id", orgId)
    .order("priority_score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  const sourceFilter =
    sp.source === "planner_seed_external_event" ||
    sp.source === "planner_seed_external_event_finance" ||
    sp.source === "planner_seed_external_event_incident" ||
    sp.source === "planner_seed_external_event_chatops" ||
    sp.source === "planner_seed_external_event_general" ||
    sp.source === "planner_seed_case_stale" ||
    sp.source === "planner_seed_action_failed" ||
    sp.source === "planner_seed_pending_approval" ||
    sp.source === "planner_seed_policy_warn" ||
    sp.source === "planner_openai" ||
    sp.source === "planner_stub"
      ? sp.source
      : "all";

  if (sp.status && sp.status !== "all") {
    query = query.eq("status", sp.status);
  }
  if (sp.policy_status && sp.policy_status !== "all") {
    query = query.eq("policy_status", sp.policy_status);
  }
  if (sourceFilter !== "all") {
    if (sourceFilter === "planner_seed_external_event") {
      query = query.like("source", "planner_seed_external_event_%");
    } else {
      query = query.eq("source", sourceFilter);
    }
  }
  if (sp.min_priority && sp.min_priority !== "all") {
    const parsed = Number(sp.min_priority);
    if (!Number.isNaN(parsed)) {
      query = query.gte("priority_score", parsed);
    }
  }

  let { data: proposals, error } = await query;
  if (
    error &&
    (isMissingColumnError(error.message, "priority_score") ||
      isMissingColumnError(error.message, "estimated_impact_json"))
  ) {
    let fallbackQuery = supabase
      .from("task_proposals")
      .select(
        "id, source, title, rationale, proposed_actions_json, risks_json, policy_status, policy_reasons, status, created_at, decided_at"
      )
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (sp.status && sp.status !== "all") {
      fallbackQuery = fallbackQuery.eq("status", sp.status);
    }
    if (sp.policy_status && sp.policy_status !== "all") {
      fallbackQuery = fallbackQuery.eq("policy_status", sp.policy_status);
    }
    if (sourceFilter !== "all") {
      if (sourceFilter === "planner_seed_external_event") {
        fallbackQuery = fallbackQuery.like("source", "planner_seed_external_event_%");
      } else {
        fallbackQuery = fallbackQuery.eq("source", sourceFilter);
      }
    }
    const fallback = await fallbackQuery;
    proposals = (fallback.data ?? []).map((row) => ({
      ...row,
      priority_score: 0,
      estimated_impact_json: {},
      decision_reason: null
    }));
    error = fallback.error;
  }
  if (sp.decision_reason_prefix && sp.decision_reason_prefix !== "all") {
    proposals = (proposals ?? []).filter(
      (proposal) => decisionReasonPrefix(proposal.decision_reason) === sp.decision_reason_prefix
    );
  }
  const missingCoreTable = error ? isMissingTableError(error.message, "task_proposals") : false;
  if (error && !missingCoreTable) {
    throw new Error(`Failed to load proposals: ${error.message}`);
  }

  const proposalRows = missingCoreTable ? [] : proposals ?? [];
  const statusCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const policyCounts = new Map<string, number>();
  for (const row of proposalRows) {
    const status = String(row.status ?? "unknown");
    const policy = String(row.policy_status ?? "unknown");
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    policyCounts.set(policy, (policyCounts.get(policy) ?? 0) + 1);
    if (status === "rejected" || status === "accepted") {
      const key = decisionReasonPrefix(row.decision_reason);
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
  }
  const reasonOptions = [
    "accepted_low_risk",
    "accepted_manual",
    "accepted_after_review",
    "rejected_low_value",
    "rejected_policy",
    "rejected_duplicate",
    "rejected_scope",
    "rejected_other",
    "unspecified"
  ];
  const hasActiveFilters =
    (sp.status ?? "all") !== "all" ||
    (sp.policy_status ?? "all") !== "all" ||
    sourceFilter !== "all" ||
    (sp.min_priority ?? "all") !== "all" ||
    (sp.decision_reason_prefix ?? "all") !== "all";
  const activeFilterSummary = [
    (sp.status ?? "all") !== "all" ? `ステータス=${proposalStatusLabel(String(sp.status))}` : null,
    (sp.policy_status ?? "all") !== "all" ? `ポリシー状態=${policyStatusLabel(String(sp.policy_status))}` : null,
    sourceFilter !== "all" ? `提案ソース=${sourceLabel(sourceFilter)}` : null,
    (sp.min_priority ?? "all") !== "all" ? `最低優先度=${String(sp.min_priority)}` : null,
    (sp.decision_reason_prefix ?? "all") !== "all" ? `判断理由=${reasonCodeLabel(String(sp.decision_reason_prefix))}` : null
  ]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const currentFilterParams = new URLSearchParams();
  currentFilterParams.set("status", String(sp.status ?? "all"));
  currentFilterParams.set("policy_status", String(sp.policy_status ?? "all"));
  currentFilterParams.set("source", sourceFilter);
  currentFilterParams.set("min_priority", String(sp.min_priority ?? "all"));
  currentFilterParams.set("decision_reason_prefix", String(sp.decision_reason_prefix ?? "all"));
  const currentFilterPath = `/app/proposals?${currentFilterParams.toString()}`;

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">タスク提案</h1>
          <p className="mt-2 text-sm text-slate-600">
            自律プランナーの提案一覧です。受け入れると実タスクに変換され、通常の承認・実行フローへ進みます。
          </p>
        </div>
        <Link href="/app/planner" className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700">
          プランナーを開く
        </Link>
      </div>

      {sp.ok ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {sp.ok}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {sp.error}
        </p>
      ) : null}
      {missingCoreTable ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          `task_proposals` テーブルが未適用です。`supabase db push` で migration を適用してください。
        </p>
      ) : null}

      <form method="get" className="flex flex-wrap gap-3 rounded-md border border-slate-200 p-3 text-sm">
        <label className="flex items-center gap-2">
          ステータス
          <select name="status" defaultValue={sp.status ?? "all"} className="rounded-md border border-slate-300 px-2 py-1">
            <option value="all">すべて</option>
            <option value="proposed">提案中</option>
            <option value="accepted">受け入れ済み</option>
            <option value="rejected">却下済み</option>
            <option value="executed">実行済み</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          ポリシー状態
          <select
            name="policy_status"
            defaultValue={sp.policy_status ?? "all"}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="all">すべて</option>
            <option value="pass">許可</option>
            <option value="warn">注意</option>
            <option value="block">ブロック</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          提案ソース
          <select
            name="source"
            defaultValue={sourceFilter}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="all">すべて</option>
            <option value="planner_seed_external_event">外部イベント</option>
            <option value="planner_seed_external_event_finance">外部イベント: 経理</option>
            <option value="planner_seed_external_event_incident">外部イベント: 障害/セキュリティ</option>
            <option value="planner_seed_external_event_chatops">外部イベント: チャット依頼</option>
            <option value="planner_seed_external_event_general">外部イベント: 汎用</option>
            <option value="planner_seed_case_stale">滞留案件</option>
            <option value="planner_seed_action_failed">実行失敗</option>
            <option value="planner_seed_pending_approval">承認滞留</option>
            <option value="planner_seed_policy_warn">ポリシー警告</option>
            <option value="planner_openai">OpenAI生成</option>
            <option value="planner_stub">stub</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          最低優先度
          <select
            name="min_priority"
            defaultValue={sp.min_priority ?? "all"}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="all">すべて</option>
            <option value="30">30以上</option>
            <option value="60">60以上</option>
            <option value="80">80以上</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          判断理由
          <select
            name="decision_reason_prefix"
            defaultValue={sp.decision_reason_prefix ?? "all"}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="all">すべて</option>
            {reasonOptions.map((option) => (
              <option key={option} value={option}>
                {reasonCodeLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-white">
          適用
        </button>
        <CopyFilterLinkButton path={currentFilterPath} />
        {hasActiveFilters ? (
          <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">条件付き表示</span>
        ) : null}
      </form>
      {hasActiveFilters ? <p className="-mt-3 text-xs text-slate-600">{activeFilterSummary}</p> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-600">提案中</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{statusCounts.get("proposed") ?? 0}</p>
        </div>
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">受け入れ済み</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{statusCounts.get("accepted") ?? 0}</p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="text-rose-700">却下済み</p>
          <p className="mt-1 text-2xl font-semibold text-rose-900">{statusCounts.get("rejected") ?? 0}</p>
        </div>
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-3 text-sm">
        <p className="font-medium text-slate-900">判断理由サマリ</p>
        {Array.from(reasonCounts.entries()).length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {Array.from(reasonCounts.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([reason, count]) => (
                <span key={reason} className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-xs">
                  {reasonCodeLabel(reason)}: {count}
                </span>
              ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-500">まだ判断理由データがありません。</p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          ポリシー内訳（許可/注意/ブロック）: {policyCounts.get("pass") ?? 0}/{policyCounts.get("warn") ?? 0}/
          {policyCounts.get("block") ?? 0}
        </p>
      </div>

      <form id="bulk-reject-form" action={bulkRejectProposals} className="rounded-md border border-rose-200 bg-rose-50 p-3">
        <p className="text-sm font-medium text-rose-900">提案の一括却下</p>
        <p className="mt-1 text-xs text-rose-700">下の一覧でチェックした「提案中」アイテムのみをまとめて却下します。</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            name="decision_reason_code"
            defaultValue="rejected_other"
            className="rounded-md border border-rose-300 px-2 py-1 text-xs"
          >
            <option value="rejected_other">{reasonCodeLabel("rejected_other")}</option>
            <option value="rejected_policy">{reasonCodeLabel("rejected_policy")}</option>
            <option value="rejected_low_value">{reasonCodeLabel("rejected_low_value")}</option>
            <option value="rejected_duplicate">{reasonCodeLabel("rejected_duplicate")}</option>
            <option value="rejected_scope">{reasonCodeLabel("rejected_scope")}</option>
          </select>
          <input
            type="text"
            name="reason_note"
            placeholder="補足メモ（任意）"
            className="rounded-md border border-rose-300 px-3 py-1.5 text-xs"
          />
          <button type="submit" className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-100">
            選択提案を一括却下
          </button>
        </div>
      </form>

      {proposalRows.length > 0 ? (
        <ul className="space-y-3">
          {proposalRows.map((proposal) => {
            const actions = parseActions(proposal.proposed_actions_json);
            const risks = parseStringList(proposal.risks_json);
            const reasons = parseStringList(proposal.policy_reasons);
            const source = String(proposal.source ?? "");
            const priority = Number(proposal.priority_score ?? 0);
            const isCaseStaleSeed = source === "planner_seed_case_stale";
            const isUrgent = isCaseStaleSeed || priority >= 80 || proposal.policy_status === "warn";
            const estimatedImpact =
              typeof proposal.estimated_impact_json === "object" && proposal.estimated_impact_json !== null
                ? (proposal.estimated_impact_json as Record<string, unknown>)
                : {};
            const canAccept = proposal.status === "proposed" && proposal.policy_status !== "block";
            return (
              <li
                key={proposal.id}
                className={`rounded-md border p-4 text-sm text-slate-700 ${isUrgent ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}
              >
                {proposal.status === "proposed" ? (
                  <label className="mb-2 inline-flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      name="proposal_ids"
                      value={proposal.id as string}
                      form="bulk-reject-form"
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    一括却下対象に含める
                  </label>
                ) : null}
                <p className="font-medium text-slate-900">{proposal.title as string}</p>
                <p className="mt-1 text-xs text-slate-500">
                  ソース: {sourceLabel(source)} | ステータス: {proposalStatusLabel(proposal.status as string)} | ポリシー状態:{" "}
                  {policyStatusLabel(proposal.policy_status as string)} |
                  優先度: {priority}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {isCaseStaleSeed ? (
                    <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
                      滞留案件由来
                    </span>
                  ) : null}
                  {priority >= 80 ? (
                    <span className="rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 text-[11px] text-rose-700">
                      高優先度
                    </span>
                  ) : null}
                  {proposal.policy_status === "warn" ? (
                    <span className="rounded-full border border-fuchsia-300 bg-fuchsia-100 px-2 py-0.5 text-[11px] text-fuchsia-700">
                      ポリシー要注意
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 whitespace-pre-wrap">{proposal.rationale as string}</p>
                <p className="mt-2 text-xs text-slate-500">
                  影響見込み: 対象件数 {String(estimatedImpact.affected_work_items ?? 0)} / 削減時間(分){" "}
                  {String(estimatedImpact.likely_time_saved_minutes ?? 0)}
                </p>

                {actions.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer font-medium">提案アクション</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                      {toRedactedJson(actions[0])}
                    </pre>
                  </details>
                ) : null}

                {risks.length > 0 ? (
                  <div className="mt-2">
                    <p className="font-medium">リスク</p>
                    <ul className="list-disc pl-5">
                      {risks.map((risk) => (
                        <li key={risk}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {reasons.length > 0 ? (
                  <div className="mt-2">
                    <p className="font-medium">ポリシー理由</p>
                    <ul className="list-disc pl-5">
                      {reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <p className="mt-2 text-xs text-slate-500">
                  作成日時: {new Date(proposal.created_at as string).toLocaleString("ja-JP")}
                </p>
                {proposal.decision_reason ? (
                  <p className="mt-1 text-xs text-slate-500">
                    判断理由: {reasonCodeLabel(decisionReasonPrefix(proposal.decision_reason))}
                    {String(proposal.decision_reason).includes(":")
                      ? `（${String(proposal.decision_reason).slice(String(proposal.decision_reason).indexOf(":") + 1)}）`
                      : ""}
                  </p>
                ) : null}

                {proposal.status === "proposed" ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {isUrgent ? (
                      <form action={acceptProposal}>
                        <input type="hidden" name="proposal_id" value={proposal.id as string} />
                        <input type="hidden" name="decision_reason_code" value="accepted_after_review" />
                        <input type="hidden" name="auto_request_approval" value="1" />
                        <button
                          type="submit"
                          disabled={!canAccept}
                          className="rounded-md border border-amber-300 bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          最短実行: 受け入れ+承認依頼
                        </button>
                      </form>
                    ) : null}
                    <form action={acceptProposal}>
                      <input type="hidden" name="proposal_id" value={proposal.id as string} />
                      <select
                        name="decision_reason_code"
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                        defaultValue="accepted_manual"
                      >
                        <option value="accepted_manual">{reasonCodeLabel("accepted_manual")}</option>
                        <option value="accepted_after_review">{reasonCodeLabel("accepted_after_review")}</option>
                        <option value="accepted_low_risk">{reasonCodeLabel("accepted_low_risk")}</option>
                      </select>
                      <button
                        type="submit"
                        disabled={!canAccept}
                        className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        受け入れ
                      </button>
                      <button
                        type="submit"
                        name="auto_request_approval"
                        value="1"
                        disabled={!canAccept}
                        className="ml-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        受け入れ+承認依頼
                      </button>
                    </form>
                    <form action={rejectProposal} className="flex items-center gap-2">
                      <input type="hidden" name="proposal_id" value={proposal.id as string} />
                      <select
                        name="decision_reason_code"
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                        defaultValue="rejected_other"
                      >
                        <option value="rejected_other">{reasonCodeLabel("rejected_other")}</option>
                        <option value="rejected_policy">{reasonCodeLabel("rejected_policy")}</option>
                        <option value="rejected_low_value">{reasonCodeLabel("rejected_low_value")}</option>
                        <option value="rejected_duplicate">{reasonCodeLabel("rejected_duplicate")}</option>
                        <option value="rejected_scope">{reasonCodeLabel("rejected_scope")}</option>
                      </select>
                      <input
                        type="text"
                        name="reason_note"
                        placeholder="補足メモ（任意）"
                        className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                      <button
                        type="submit"
                        className="rounded-md border border-rose-300 px-3 py-2 text-sm text-rose-700 hover:bg-rose-50"
                      >
                        却下
                      </button>
                    </form>
                    {!canAccept ? (
                      <p className="text-xs text-rose-700">block の提案は受け入れできません。</p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-slate-600">この条件に一致する提案はありません。</p>
      )}
    </section>
  );
}
