import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { saveDailySendEmailLimit } from "@/app/app/governance/budgets/actions";

export const dynamic = "force-dynamic";

type BudgetsPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export default async function BudgetsPage({ searchParams }: BudgetsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  const [limitRes, usageRes] = await Promise.all([
    supabase
      .from("budget_limits")
      .select("id, provider, action_type, period, limit_count, updated_at")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false }),
    supabase
      .from("budget_usage")
      .select("id, provider, action_type, usage_date, used_count, updated_at")
      .eq("org_id", orgId)
      .order("usage_date", { ascending: false })
      .limit(30)
  ]);

  if (limitRes.error && !isMissingTableError(limitRes.error.message, "budget_limits")) {
    throw new Error(`budget_limits query failed: ${limitRes.error.message}`);
  }
  if (usageRes.error && !isMissingTableError(usageRes.error.message, "budget_usage")) {
    throw new Error(`budget_usage query failed: ${usageRes.error.message}`);
  }

  const limits = isMissingTableError(limitRes.error?.message ?? "", "budget_limits") ? [] : (limitRes.data ?? []);
  const usages = isMissingTableError(usageRes.error?.message ?? "", "budget_usage") ? [] : (usageRes.data ?? []);

  const dailyGoogleLimit =
    (limits.find(
      (limit) => limit.provider === "google" && limit.action_type === "send_email" && limit.period === "daily"
    )?.limit_count as number | undefined) ?? 20;

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">予算ガバナンス</h1>
        <p className="mt-2 text-sm text-slate-600">
          コネクタ実行の利用上限と当日使用量を監視し、`google/send_email` の日次上限を更新できます。
        </p>
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

      <div>
        <h2 className="text-base font-semibold">設定済み上限</h2>
        <form action={saveDailySendEmailLimit} className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="limit_count">
              Google send_email 日次上限
            </label>
            <input
              id="limit_count"
              name="limit_count"
              type="number"
              min={0}
              defaultValue={dailyGoogleLimit}
              className="w-52 rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white">
            上限を保存
          </button>
        </form>
        {limits.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">上限は未設定です（デフォルト値で評価されます）。</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {limits.map((limit) => (
              <li key={limit.id} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                {limit.provider}/{limit.action_type} ({limit.period}) 上限: {limit.limit_count}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="text-base font-semibold">直近30日の使用量</h2>
        {usages.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">使用量データはまだありません。</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {usages.map((usage) => (
              <li key={usage.id} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                {usage.usage_date}: {usage.provider}/{usage.action_type} 使用数 {usage.used_count}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
