import Link from "next/link";
import { acceptProposal, rejectProposal } from "@/app/app/proposals/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ProposalsPageProps = {
  searchParams?: Promise<{
    status?: string;
    policy_status?: string;
    min_priority?: string;
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

export default async function ProposalsPage({ searchParams }: ProposalsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  let query = supabase
    .from("task_proposals")
    .select(
      "id, source, title, rationale, proposed_actions_json, risks_json, policy_status, policy_reasons, priority_score, estimated_impact_json, status, created_at, decided_at"
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
      estimated_impact_json: {}
    }));
    error = fallback.error;
  }
  if (error) {
    throw new Error(`Failed to load proposals: ${error.message}`);
  }

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
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-white">
          適用
        </button>
      </form>

      {proposals && proposals.length > 0 ? (
        <ul className="space-y-3">
          {proposals.map((proposal) => {
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

                {proposal.status === "proposed" ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <form action={acceptProposal}>
                      <input type="hidden" name="proposal_id" value={proposal.id as string} />
                      <button
                        type="submit"
                        disabled={!canAccept}
                        className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        受け入れ
                      </button>
                    </form>
                    <form action={rejectProposal} className="flex items-center gap-2">
                      <input type="hidden" name="proposal_id" value={proposal.id as string} />
                      <input
                        type="text"
                        name="reason"
                        placeholder="却下理由"
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
