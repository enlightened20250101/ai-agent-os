import {
  saveSlackConnector,
  sendSlackOpsAlertTestMessage,
  sendSlackTestMessage
} from "@/app/app/integrations/slack/actions";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { getConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import { getSlackEnvStatus } from "@/lib/connectors/runtime";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

type SlackIntegrationPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
  }>;
};

export default async function SlackIntegrationPage({ searchParams }: SlackIntegrationPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const envStatus = getSlackEnvStatus();
  const connector = await getConnectorAccount({ supabase, orgId, provider: "slack" });
  const dbSecrets = (connector?.secrets_json ?? {}) as Record<string, unknown>;
  const dbStatus = {
    botToken: typeof dbSecrets.bot_token === "string" && dbSecrets.bot_token.length > 0,
    signingSecret: typeof dbSecrets.signing_secret === "string" && dbSecrets.signing_secret.length > 0,
    approvalChannelId:
      typeof dbSecrets.approval_channel_id === "string" && dbSecrets.approval_channel_id.length > 0,
    alertChannelId: typeof dbSecrets.alert_channel_id === "string" && dbSecrets.alert_channel_id.length > 0,
    intakeChannelId: typeof dbSecrets.intake_channel_id === "string" && dbSecrets.intake_channel_id.length > 0
  };
  const sp = searchParams ? await searchParams : {};

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">Slack 連携</h1>
        <p className="mt-2 text-sm text-slate-600">
          Slack を任意の承認チャネルとして設定できます。Slack未設定でもWeb承認は利用可能です。
        </p>
      </div>

      <StatusNotice ok={sp.ok} error={sp.error} />

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">コネクタソース</p>
          <p className="text-slate-700">{connector ? "データベース（優先）" : "env フォールバック"}</p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">保存済みワークスペース</p>
          <p className="text-slate-700">
            {connector ? `${connector.external_account_id}${connector.display_name ? ` (${connector.display_name})` : ""}` : "（なし）"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB Botトークン</p>
          <p className={dbStatus.botToken ? "text-emerald-700" : "text-rose-700"}>
            {dbStatus.botToken ? "設定済み" : "未設定"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB Signing Secret</p>
          <p className={dbStatus.signingSecret ? "text-emerald-700" : "text-rose-700"}>
            {dbStatus.signingSecret ? "設定済み" : "未設定"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB 承認チャンネルID</p>
          <p className={dbStatus.approvalChannelId ? "text-emerald-700" : "text-rose-700"}>
            {dbStatus.approvalChannelId ? "設定済み" : "未設定"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB アラートチャンネルID</p>
          <p className={dbStatus.alertChannelId ? "text-emerald-700" : "text-amber-700"}>
            {dbStatus.alertChannelId ? "設定済み" : "未設定（approval_channel_idにフォールバック）"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB 取り込みチャンネルID</p>
          <p className={dbStatus.intakeChannelId ? "text-emerald-700" : "text-amber-700"}>
            {dbStatus.intakeChannelId ? "設定済み" : "未設定（approval_channel_idにフォールバック）"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Envフォールバック状態</p>
          <p
            className={
              envStatus.botToken && envStatus.signingSecret && envStatus.approvalChannelId
                ? "text-emerald-700"
                : "text-amber-700"
            }
          >
            {envStatus.botToken && envStatus.signingSecret && envStatus.approvalChannelId
              ? "設定完了"
              : "不足あり"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Env アラートチャンネル</p>
          <p className={envStatus.alertChannelId ? "text-emerald-700" : "text-amber-700"}>
            {envStatus.alertChannelId ? "設定済み" : "未設定（approval channelへフォールバック）"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Env 取り込みチャンネル</p>
          <p className={envStatus.intakeChannelId ? "text-emerald-700" : "text-amber-700"}>
            {envStatus.intakeChannelId ? "設定済み" : "未設定（approval channelへフォールバック）"}
          </p>
        </div>
      </div>

      <form action={saveSlackConnector} className="grid gap-3 rounded-md border border-slate-200 p-4">
        <p className="text-sm font-medium text-slate-900">組織のSlackコネクタを保存</p>
        <input
          type="text"
          name="workspace_id"
          placeholder="ワークスペース/チームID（任意）"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          name="display_name"
          placeholder="表示名（任意）"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="password"
          name="bot_token"
          placeholder="xoxb-..."
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          required
        />
        <input
          type="password"
          name="signing_secret"
          placeholder="Slack Signing Secret"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          required
        />
        <input
          type="text"
          name="approval_channel_id"
          placeholder="C01234567"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          required
        />
        <input
          type="text"
          name="alert_channel_id"
          placeholder="運用アラート通知先channel_id（任意）"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          name="intake_channel_id"
          placeholder="タスク取り込み対象channel_id（任意）"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <div>
          <ConfirmSubmitButton
            label="コネクタを保存"
            pendingLabel="保存中..."
            confirmMessage="この内容でSlackコネクタ設定を保存します。実行しますか？"
            className="rounded-md bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-600"
          />
        </div>
      </form>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium text-slate-900">設定手順</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Slackアプリを作成し、Interactivityを有効化します。</li>
          <li>Event Subscriptionsを有効化し、Request URL を `{process.env.APP_BASE_URL ?? "http://localhost:3000"}/api/slack/events` に設定します。</li>
          <li>Request URL を `{process.env.APP_BASE_URL ?? "http://localhost:3000"}/api/slack/actions` に設定します。</li>
          <li>Bot scopes は最低 `chat:write`, `app_mentions:read`, `channels:history`, `groups:history`, `im:history` を付与します。</li>
          <li>ワークスペースへアプリをインストールし、この画面で Botトークン / Signing Secret / channel を保存します。</li>
          <li>`intake_channel_id` 未設定時は `approval_channel_id` を取り込み対象として扱います。</li>
          <li>DBコネクタ未設定時は env 変数をフォールバックとして使用します。</li>
        </ol>
      </div>

      <form action={sendSlackTestMessage}>
        <div className="flex flex-wrap gap-2">
          <ConfirmSubmitButton
            label="承認チャネル テスト送信"
            pendingLabel="送信中..."
            confirmMessage="承認チャネルへテストメッセージを送信します。実行しますか？"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          />
        </div>
      </form>

      <form action={sendSlackOpsAlertTestMessage}>
        <ConfirmSubmitButton
          label="Opsアラート テスト送信"
          pendingLabel="送信中..."
          confirmMessage="Opsアラートチャネルへテスト送信します。実行しますか？"
          className="rounded-md bg-indigo-700 px-4 py-2 text-sm text-white hover:bg-indigo-600"
        />
      </form>
    </section>
  );
}
