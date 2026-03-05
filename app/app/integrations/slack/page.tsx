import { sendSlackTestMessage } from "@/app/app/integrations/slack/actions";
import { requireOrgContext } from "@/lib/org/context";
import { getSlackEnvStatus } from "@/lib/slack/client";

type SlackIntegrationPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
  }>;
};

export default async function SlackIntegrationPage({ searchParams }: SlackIntegrationPageProps) {
  await requireOrgContext();
  const status = getSlackEnvStatus();
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
          <p className="font-medium">SLACK_BOT_TOKEN</p>
          <p className={status.botToken ? "text-emerald-700" : "text-rose-700"}>
            {status.botToken ? "configured" : "missing"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">SLACK_SIGNING_SECRET</p>
          <p className={status.signingSecret ? "text-emerald-700" : "text-rose-700"}>
            {status.signingSecret ? "configured" : "missing"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">SLACK_APPROVAL_CHANNEL_ID</p>
          <p className={status.approvalChannelId ? "text-emerald-700" : "text-rose-700"}>
            {status.approvalChannelId ? "configured" : "missing"}
          </p>
        </div>
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium text-slate-900">Setup Instructions</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Create a Slack app and enable Interactivity.</li>
          <li>Set Request URL to `{process.env.APP_BASE_URL ?? "http://localhost:3000"}/api/slack/actions`.</li>
          <li>Install app to workspace and copy Bot Token and Signing Secret to env vars.</li>
          <li>Set `SLACK_APPROVAL_CHANNEL_ID` to the target channel ID.</li>
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
