import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { declareIncident, resolveIncident } from "@/app/app/governance/incidents/actions";
import { listOpenIncidents } from "@/lib/governance/incidents";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type IncidentsPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

function severityLabel(value: string) {
  if (value === "critical") return "重大";
  if (value === "warning") return "警告";
  if (value === "info") return "情報";
  return value;
}

export default async function IncidentsPage({ searchParams }: IncidentsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  const openIncidents = await listOpenIncidents({ supabase, orgId });

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">インシデントモード</h1>
        <p className="mt-2 text-sm text-slate-600">
          インシデント宣言中はガバナンス判定が強制ブロックになり、自動実行を停止します。
        </p>
      </div>

      <StatusNotice ok={sp.ok} error={sp.error} />

      <div className="rounded-md border border-slate-200 p-4">
        <h2 className="text-base font-semibold">インシデントを宣言</h2>
        <form action={declareIncident} className="mt-3 space-y-3">
          <div>
            <label htmlFor="severity" className="mb-1 block text-sm font-medium text-slate-700">
              深刻度
            </label>
            <select
              id="severity"
              name="severity"
              defaultValue="critical"
              className="w-48 rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="critical">重大</option>
              <option value="warning">警告</option>
              <option value="info">情報</option>
            </select>
          </div>
          <div>
            <label htmlFor="reason" className="mb-1 block text-sm font-medium text-slate-700">
              理由
            </label>
            <textarea
              id="reason"
              name="reason"
              rows={3}
              required
              placeholder="例: Gmail API障害のため自動送信を停止"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <ConfirmSubmitButton
            label="インシデント宣言"
            pendingLabel="宣言中..."
            confirmMessage="インシデントを宣言し、自動実行を制限します。実行しますか？"
            className="rounded-md bg-rose-700 px-4 py-2 text-sm text-white hover:bg-rose-600"
          />
        </form>
      </div>

      <div>
        <h2 className="text-base font-semibold">現在のオープンインシデント</h2>
        {openIncidents.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">オープン中のインシデントはありません。</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {openIncidents.map((incident) => (
              <li key={incident.id} className="rounded-md border border-rose-200 bg-rose-50/50 p-4 text-sm">
                <p className="font-medium text-rose-800">
                  {severityLabel(incident.severity)} | {incident.reason}
                </p>
                <p className="mt-1 text-rose-700">発生日時: {new Date(incident.opened_at).toLocaleString("ja-JP")}</p>
                <form action={resolveIncident} className="mt-3">
                  <input type="hidden" name="incident_id" value={incident.id} />
                  <ConfirmSubmitButton
                    label="解決済みにする"
                    pendingLabel="更新中..."
                    confirmMessage="このインシデントを解決済みに更新します。実行しますか？"
                    className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm text-rose-700 hover:bg-rose-100"
                  />
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
