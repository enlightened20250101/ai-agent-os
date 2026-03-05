import Link from "next/link";
import { acceptProposal, bulkRejectProposals, rejectProposal } from "@/app/app/proposals/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ProposalsPageProps = {
  searchParams?: Promise<{
    status?: string;
    policy_status?: string;
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

function decisionReasonPrefix(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return "unspecified";
  const idx = value.indexOf(":");
  return (idx >= 0 ? value.slice(0, idx) : value).trim() || "unspecified";
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

  if (sp.status && sp.status !== "all") {
    query = query.eq("status", sp.status);
  }
  if (sp.policy_status && sp.policy_status !== "all") {
    query = query.eq("policy_status", sp.policy_status);
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
  if (error) {
    throw new Error(`Failed to load proposals: ${error.message}`);
  }

  const proposalRows = proposals ?? [];
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
            <option value="pass">pass</option>
            <option value="warn">warn</option>
            <option value="block">block</option>
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
                {option}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-white">
          適用
        </button>
      </form>

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
                  {reason}: {count}
                </span>
              ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-500">まだ判断理由データがありません。</p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          policy pass/warn/block: {policyCounts.get("pass") ?? 0}/{policyCounts.get("warn") ?? 0}/
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
            <option value="rejected_other">rejected_other</option>
            <option value="rejected_policy">rejected_policy</option>
            <option value="rejected_low_value">rejected_low_value</option>
            <option value="rejected_duplicate">rejected_duplicate</option>
            <option value="rejected_scope">rejected_scope</option>
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
            const estimatedImpact =
              typeof proposal.estimated_impact_json === "object" && proposal.estimated_impact_json !== null
                ? (proposal.estimated_impact_json as Record<string, unknown>)
                : {};
            const canAccept = proposal.status === "proposed" && proposal.policy_status !== "block";
            return (
              <li key={proposal.id} className="rounded-md border border-slate-200 p-4 text-sm text-slate-700">
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
                  ソース: {proposal.source as string} | ステータス: {proposal.status as string} | ポリシー状態:{" "}
                  {proposal.policy_status as string} | 優先度: {Number(proposal.priority_score ?? 0)}
                </p>
                <p className="mt-2 whitespace-pre-wrap">{proposal.rationale as string}</p>
                <p className="mt-2 text-xs text-slate-500">
                  影響見込み: 対象件数 {String(estimatedImpact.affected_work_items ?? 0)} / 削減時間(分){" "}
                  {String(estimatedImpact.likely_time_saved_minutes ?? 0)}
                </p>

                {actions.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer font-medium">提案アクション</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                      {JSON.stringify(actions[0], null, 2)}
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
                  作成日時: {new Date(proposal.created_at as string).toLocaleString()}
                </p>
                {proposal.decision_reason ? (
                  <p className="mt-1 text-xs text-slate-500">判断理由: {String(proposal.decision_reason)}</p>
                ) : null}

                {proposal.status === "proposed" ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <form action={acceptProposal}>
                      <input type="hidden" name="proposal_id" value={proposal.id as string} />
                      <select
                        name="decision_reason_code"
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                        defaultValue="accepted_manual"
                      >
                        <option value="accepted_manual">accepted_manual</option>
                        <option value="accepted_after_review">accepted_after_review</option>
                        <option value="accepted_low_risk">accepted_low_risk</option>
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
                        <option value="rejected_other">rejected_other</option>
                        <option value="rejected_policy">rejected_policy</option>
                        <option value="rejected_low_value">rejected_low_value</option>
                        <option value="rejected_duplicate">rejected_duplicate</option>
                        <option value="rejected_scope">rejected_scope</option>
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
