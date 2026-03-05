import { saveSlackConnector, sendSlackTestMessage } from "@/app/app/integrations/slack/actions";
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
      typeof dbSecrets.approval_channel_id === "string" && dbSecrets.approval_channel_id.length > 0
  };
  const sp = searchParams ? await searchParams : {};

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">Slack Integration</h1>
        <p className="mt-2 text-sm text-slate-600">
          Configure Slack as an optional approval channel. Web approvals remain available even if Slack
          is not configured.
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

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Connector source</p>
          <p className="text-slate-700">{connector ? "database (primary)" : "env fallback"}</p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Saved workspace</p>
          <p className="text-slate-700">
            {connector ? `${connector.external_account_id}${connector.display_name ? ` (${connector.display_name})` : ""}` : "(none)"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB bot_token</p>
          <p className={dbStatus.botToken ? "text-emerald-700" : "text-rose-700"}>
            {dbStatus.botToken ? "configured" : "missing"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB signing_secret</p>
          <p className={dbStatus.signingSecret ? "text-emerald-700" : "text-rose-700"}>
            {dbStatus.signingSecret ? "configured" : "missing"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB approval_channel_id</p>
          <p className={dbStatus.approvalChannelId ? "text-emerald-700" : "text-rose-700"}>
            {dbStatus.approvalChannelId ? "configured" : "missing"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Env fallback status</p>
          <p className={envStatus.botToken && envStatus.signingSecret && envStatus.approvalChannelId ? "text-emerald-700" : "text-amber-700"}>
            {envStatus.botToken && envStatus.signingSecret && envStatus.approvalChannelId
              ? "fully configured"
              : "partial or missing"}
          </p>
        </div>
      </div>

      <form action={saveSlackConnector} className="grid gap-3 rounded-md border border-slate-200 p-4">
        <p className="text-sm font-medium text-slate-900">Save org Slack connector</p>
        <input
          type="text"
          name="workspace_id"
          placeholder="workspace/team id (optional)"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          name="display_name"
          placeholder="display name (optional)"
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
          placeholder="Slack signing secret"
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
        <div>
          <button
            type="submit"
            className="rounded-md bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-600"
          >
            Save connector
          </button>
        </div>
      </form>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium text-slate-900">Setup Instructions</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Create a Slack app and enable Interactivity.</li>
          <li>Set Request URL to `{process.env.APP_BASE_URL ?? "http://localhost:3000"}/api/slack/actions`.</li>
          <li>Install app to workspace and save bot token/signing secret/channel in this page.</li>
          <li>Env vars remain fallback when no DB connector is configured.</li>
        </ol>
      </div>

      <form action={sendSlackTestMessage}>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
        >
          Send test message
        </button>
      </form>
    </section>
  );
}
