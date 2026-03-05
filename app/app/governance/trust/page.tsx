import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { getGovernanceSettings } from "@/lib/governance/evaluate";

export const dynamic = "force-dynamic";

function isMissingTrustTable(message: string) {
  return (
    message.includes('relation "trust_scores" does not exist') ||
    message.includes("Could not find the table 'public.trust_scores'")
  );
}

type TrustRow = {
  id: string;
  provider: string | null;
  action_type: string | null;
  agent_role_key: string | null;
  score: number;
  sample_size: number;
  metadata_json: unknown;
  updated_at: string;
};

type TrustPageProps = {
  searchParams?: Promise<{ days?: string; role?: string; provider?: string; action_type?: string }>;
};

function trustKey(row: TrustRow) {
  return `${row.provider ?? "any"}|${row.action_type ?? "any"}|${row.agent_role_key ?? "any"}`;
}

function parseDays(raw: string | undefined) {
  const allowed = new Set([7, 30, 90, 365]);
  const parsed = Number.parseInt(raw ?? "30", 10);
  return allowed.has(parsed) ? parsed : 30;
}

function parseOutcomeCount(rows: TrustRow[]) {
  let success = 0;
  let failed = 0;
  for (const row of rows) {
    const meta = row.metadata_json as { outcome?: unknown } | null;
    if (meta?.outcome === "success") {
      success += 1;
    } else if (meta?.outcome === "failed") {
      failed += 1;
    }
  }
  return { success, failed };
}

export default async function TrustGovernancePage({ searchParams }: TrustPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const settings = await getGovernanceSettings({ supabase, orgId });
  const sp = searchParams ? await searchParams : {};
  const days = parseDays(sp.days);
  const roleFilter = (sp.role ?? "").trim();
  const providerFilter = (sp.provider ?? "").trim();
  const actionTypeFilter = (sp.action_type ?? "").trim();
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("trust_scores")
    .select("id, provider, action_type, agent_role_key, score, sample_size, metadata_json, updated_at")
    .eq("org_id", orgId)
    .gte("updated_at", sinceIso)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (roleFilter) {
    query = query.eq("agent_role_key", roleFilter);
  }
  if (providerFilter) {
    query = query.eq("provider", providerFilter);
  }
  if (actionTypeFilter) {
    query = query.eq("action_type", actionTypeFilter);
  }

  const [{ data, error }, { data: roleRows, error: roleError }, { data: dimensionRows, error: dimensionError }] = await Promise.all([
    query,
    supabase
      .from("trust_scores")
      .select("agent_role_key")
      .eq("org_id", orgId)
      .not("agent_role_key", "is", null)
      .order("agent_role_key", { ascending: true })
      .limit(200),
    supabase
      .from("trust_scores")
      .select("provider, action_type")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(500)
  ]);

  if (error && !isMissingTrustTable(error.message)) {
    throw new Error(`trust_scores query failed: ${error.message}`);
  }
  if (roleError && !isMissingTrustTable(roleError.message)) {
    throw new Error(`trust_scores roles query failed: ${roleError.message}`);
  }
  if (dimensionError && !isMissingTrustTable(dimensionError.message)) {
    throw new Error(`trust_scores dimension query failed: ${dimensionError.message}`);
  }

  const rows = isMissingTrustTable(error?.message ?? "") ? [] : ((data ?? []) as TrustRow[]);
  const availableRoles = Array.from(
    new Set((roleRows ?? []).map((row) => row.agent_role_key).filter((v): v is string => typeof v === "string"))
  ).sort((a, b) => a.localeCompare(b));
  const availableProviders = Array.from(
    new Set((dimensionRows ?? []).map((row) => row.provider).filter((v): v is string => typeof v === "string"))
  ).sort((a, b) => a.localeCompare(b));
  const availableActionTypes = Array.from(
    new Set((dimensionRows ?? []).map((row) => row.action_type).filter((v): v is string => typeof v === "string"))
  ).sort((a, b) => a.localeCompare(b));
  const latestByKey = new Map<string, TrustRow>();
  for (const row of rows) {
    const key = trustKey(row);
    if (!latestByKey.has(key)) {
      latestByKey.set(key, row);
    }
  }

  const snapshots = Array.from(latestByKey.values()).sort((a, b) => b.score - a.score);
  const averageScore =
    rows.length > 0 ? Math.round(rows.reduce((sum, row) => sum + Number(row.score ?? 0), 0) / rows.length) : null;
  const outcomes = parseOutcomeCount(rows);

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">Trust スコア</h1>
        <p className="mt-2 text-sm text-slate-600">
          実行成功/失敗と承認却下から更新される信頼スコアです。自律実行判定の `min_trust_score` に利用されます。
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 p-4">
        <div>
          <label htmlFor="days" className="mb-1 block text-sm font-medium text-slate-700">
            期間
          </label>
          <select id="days" name="days" defaultValue={String(days)} className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="7">過去7日</option>
            <option value="30">過去30日</option>
            <option value="90">過去90日</option>
            <option value="365">過去365日</option>
          </select>
        </div>
        <div>
          <label htmlFor="role" className="mb-1 block text-sm font-medium text-slate-700">
            role_key
          </label>
          <select id="role" name="role" defaultValue={roleFilter} className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="">すべて</option>
            {availableRoles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="provider" className="mb-1 block text-sm font-medium text-slate-700">
            provider
          </label>
          <select
            id="provider"
            name="provider"
            defaultValue={providerFilter}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">すべて</option>
            {availableProviders.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="action_type" className="mb-1 block text-sm font-medium text-slate-700">
            action_type
          </label>
          <select
            id="action_type"
            name="action_type"
            defaultValue={actionTypeFilter}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">すべて</option>
            {availableActionTypes.map((actionType) => (
              <option key={actionType} value={actionType}>
                {actionType}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white">
          適用
        </button>
      </form>

      <div className="grid gap-3 md:grid-cols-5">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-600">対象レコード</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{rows.length}</p>
        </div>
        <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm">
          <p className="text-indigo-700">min_trust_score</p>
          <p className="mt-1 text-lg font-semibold text-indigo-900">{settings.minTrustScore}</p>
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-600">平均スコア</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{averageScore ?? "-"}</p>
        </div>
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="text-emerald-700">success</p>
          <p className="mt-1 text-lg font-semibold text-emerald-800">{outcomes.success}</p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="text-rose-700">failed / rejected</p>
          <p className="mt-1 text-lg font-semibold text-rose-800">{outcomes.failed}</p>
        </div>
      </div>

      <div>
        <h2 className="text-base font-semibold">最新スナップショット</h2>
        {snapshots.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">まだ trust スコア履歴はありません。</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {snapshots.map((row) => (
              <li key={row.id} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                <p>
                  {row.provider ?? "any"}/{row.action_type ?? "any"} / role=
                  <span className="font-mono">{row.agent_role_key ?? "any"}</span>
                </p>
                <p className="mt-1">
                  score: <span className="font-semibold text-slate-900">{row.score}</span> | sample_size:{" "}
                  {row.sample_size}
                </p>
                <p className="mt-1 text-xs">
                  閾値差分:{" "}
                  <span
                    className={
                      row.score >= settings.minTrustScore ? "font-semibold text-emerald-700" : "font-semibold text-rose-700"
                    }
                  >
                    {row.score - settings.minTrustScore >= 0 ? "+" : ""}
                    {row.score - settings.minTrustScore}
                  </span>
                </p>
                <p className="mt-1 text-xs text-slate-500">updated_at: {new Date(row.updated_at).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="text-base font-semibold">直近履歴（200件）</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">履歴はまだありません。</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <li key={row.id} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                <p>
                  {row.provider ?? "any"}/{row.action_type ?? "any"} role={row.agent_role_key ?? "any"} | score{" "}
                  {row.score}
                </p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-slate-600">metadata</summary>
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs">
                    {JSON.stringify(row.metadata_json, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
