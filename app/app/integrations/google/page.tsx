import Link from "next/link";
import { disconnectGoogleConnector } from "@/app/app/integrations/google/actions";
import { getConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import { getGoogleEnvStatus } from "@/lib/connectors/runtime";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

type GoogleIntegrationPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
    error_description?: string;
    success?: string;
    message?: string;
  }>;
};

export default async function GoogleIntegrationPage({ searchParams }: GoogleIntegrationPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const envStatus = getGoogleEnvStatus();
  const connector = await getConnectorAccount({ supabase, orgId, provider: "google" });
  const dbSecrets = (connector?.secrets_json ?? {}) as Record<string, unknown>;
  const dbStatus = {
    refreshToken: typeof dbSecrets.refresh_token === "string" && dbSecrets.refresh_token.length > 0,
    senderEmail: typeof dbSecrets.sender_email === "string" && dbSecrets.sender_email.length > 0
  };
  const senderEmail =
    (typeof dbSecrets.sender_email === "string" && dbSecrets.sender_email) || connector?.external_account_id;
  const connected = Boolean(dbStatus.refreshToken && senderEmail);
  const sp = searchParams ? await searchParams : {};

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">Google Integration</h1>
        <p className="mt-2 text-sm text-slate-600">
          Connect Gmail for this org via OAuth. Client credentials remain server-side env config.
        </p>
      </div>

      {sp.ok || sp.success === "1" ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {sp.ok ?? "Google connector connected successfully."}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {sp.error}
          {sp.error_description ? `: ${sp.error_description}` : ""}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Connection status</p>
          <p className={connected ? "text-emerald-700" : "text-rose-700"}>
            {connected ? "connected" : "not connected"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Connected sender</p>
          <p className="text-slate-700">{senderEmail || "(none)"}</p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Server OAuth env</p>
          <p className={envStatus.clientId && envStatus.clientSecret ? "text-emerald-700" : "text-rose-700"}>
            {envStatus.clientId && envStatus.clientSecret ? "configured" : "missing"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Legacy env fallback token</p>
          <p className={envStatus.clientId && envStatus.clientSecret && envStatus.refreshToken && envStatus.senderEmail ? "text-emerald-700" : "text-amber-700"}>
            {envStatus.clientId && envStatus.clientSecret && envStatus.refreshToken && envStatus.senderEmail
              ? "fully configured"
              : "partial or missing"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/api/google/auth"
          className="rounded-md bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {connected ? "Reconnect Google" : "Connect Google"}
        </Link>
        {connected ? (
          <form action={disconnectGoogleConnector}>
            <button
              type="submit"
              className="rounded-md border border-rose-300 px-4 py-2 text-sm text-rose-700 hover:bg-rose-50"
            >
              Disconnect
            </button>
          </form>
        ) : null}
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium text-slate-900">OAuth Setup</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Set `APP_BASE_URL` to your reachable app URL (ngrok URL for local HTTPS testing).</li>
          <li>Set Google OAuth redirect URI to `{(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/api/google/callback`.</li>
          <li>OAuth stores `refresh_token` and sender email per org in `connector_accounts`.</li>
          <li>For MVP, secrets are plain JSON in DB (`future`: encrypted secrets at rest).</li>
        </ul>
      </div>
    </section>
  );
}
