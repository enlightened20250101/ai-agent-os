import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { saveAutonomySettings } from "@/app/app/governance/autonomy/actions";
import { getGovernanceSettings } from "@/lib/governance/evaluate";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type AutonomyPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

export default async function AutonomyPage({ searchParams }: AutonomyPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const settings = await getGovernanceSettings({ supabase, orgId });
  const sp = searchParams ? await searchParams : {};

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">自律実行ガバナンス</h1>
        <p className="mt-2 text-sm text-slate-600">
          組織ごとの自律レベルと自動実行閾値を設定します。初期値は保守的（承認必須）です。
        </p>
      </div>

      <StatusNotice ok={sp.ok} error={sp.error} />

      <form action={saveAutonomySettings} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="autonomy_level">
            自律レベル
          </label>
          <select
            id="autonomy_level"
            name="autonomy_level"
            defaultValue={settings.autonomyLevel}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="L0">L0 - 手動運用</option>
            <option value="L1">L1 - AIドラフトのみ</option>
            <option value="L2">L2 - AI提案 + 人間承認</option>
            <option value="L3">L3 - 低リスクのみ自動実行</option>
            <option value="L4">L4 - 例外時のみ介入</option>
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700" htmlFor="auto_execute_google_send_email">
          <input
            id="auto_execute_google_send_email"
            name="auto_execute_google_send_email"
            type="checkbox"
            defaultChecked={settings.autoExecuteGoogleSendEmail}
            className="h-4 w-4 rounded border-slate-300"
          />
          Google `send_email` の自動実行を許可する
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-700" htmlFor="enforce_initiator_approver_separation">
          <input
            id="enforce_initiator_approver_separation"
            name="enforce_initiator_approver_separation"
            type="checkbox"
            defaultChecked={settings.enforceInitiatorApproverSeparation}
            className="h-4 w-4 rounded border-slate-300"
          />
          起票者と承認者の分離（起票者は自分のタスクを承認不可）
        </label>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="max_auto_execute_risk_score">
              自動実行の最大リスクスコア
            </label>
            <input
              id="max_auto_execute_risk_score"
              name="max_auto_execute_risk_score"
              type="number"
              min={0}
              max={100}
              defaultValue={settings.maxAutoExecuteRiskScore}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="min_trust_score">
              最低信頼スコア
            </label>
            <input
              id="min_trust_score"
              name="min_trust_score"
              type="number"
              min={0}
              max={100}
              defaultValue={settings.minTrustScore}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="daily_send_email_limit">
              1日あたり送信上限
            </label>
            <input
              id="daily_send_email_limit"
              name="daily_send_email_limit"
              type="number"
              min={0}
              defaultValue={settings.dailySendEmailLimit}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <ConfirmSubmitButton
          label="設定を保存"
          pendingLabel="保存中..."
          confirmMessage="自律実行設定を更新します。実行しますか？"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
        />
      </form>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium text-slate-900">MVPルール</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>policy が `block` の場合は常に停止します。</li>
          <li>`L3/L4` かつ自動実行が有効のときのみ、自動実行候補になります。</li>
          <li>リスク/信頼スコア/日次予算をすべて満たした場合だけ承認バイパスします。</li>
          <li>分離を有効化すると、起票者と承認者を同一ユーザーにできません。</li>
        </ul>
      </div>
    </section>
  );
}
