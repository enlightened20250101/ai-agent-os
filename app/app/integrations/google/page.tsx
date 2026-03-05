import { saveGoogleConnector } from "@/app/app/integrations/google/actions";
import { getConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import { getGoogleEnvStatus } from "@/lib/connectors/runtime";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

type GoogleIntegrationPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
  }>;
};

export default async function GoogleIntegrationPage({ searchParams }: GoogleIntegrationPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const envStatus = getGoogleEnvStatus();
  const connector = await getConnectorAccount({ supabase, orgId, provider: "google" });
  const dbSecrets = (connector?.secrets_json ?? {}) as Record<string, unknown>;
  const dbStatus = {
    clientId: typeof dbSecrets.client_id === "string" && dbSecrets.client_id.length > 0,
    clientSecret: typeof dbSecrets.client_secret === "string" && dbSecrets.client_secret.length > 0,
    refreshToken: typeof dbSecrets.refresh_token === "string" && dbSecrets.refresh_token.length > 0,
    senderEmail: typeof dbSecrets.sender_email === "string" && dbSecrets.sender_email.length > 0
  };
  const sp = searchParams ? await searchParams : {};

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">Google Integration</h1>
        <p className="mt-2 text-sm text-slate-600">
          Configure org-scoped Gmail connector credentials for Action Runner email sends.
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
          <p className="font-medium">Saved sender</p>
          <p className="text-slate-700">{connector ? connector.external_account_id : "(none)"}</p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">DB credentials</p>
          <p className={dbStatus.clientId && dbStatus.clientSecret && dbStatus.refreshToken && dbStatus.senderEmail ? "text-emerald-700" : "text-rose-700"}>
            {dbStatus.clientId && dbStatus.clientSecret && dbStatus.refreshToken && dbStatus.senderEmail
              ? "configured"
              : "missing"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">Env fallback status</p>
          <p className={envStatus.clientId && envStatus.clientSecret && envStatus.refreshToken && envStatus.senderEmail ? "text-emerald-700" : "text-amber-700"}>
            {envStatus.clientId && envStatus.clientSecret && envStatus.refreshToken && envStatus.senderEmail
              ? "fully configured"
              : "partial or missing"}
          </p>
        </div>
      </div>

      <form action={saveGoogleConnector} className="grid gap-3 rounded-md border border-slate-200 p-4">
        <p className="text-sm font-medium text-slate-900">Save org Google connector</p>
        <input
          type="text"
          name="display_name"
          placeholder="display name (optional)"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          name="sender_email"
          placeholder="sender@gmail.com"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          required
        />
        <input
          type="text"
          name="client_id"
          placeholder="Google OAuth client id"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          required
        />
        <input
          type="password"
          name="client_secret"
          placeholder="Google OAuth client secret"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          required
        />
        <input
          type="password"
          name="refresh_token"
          placeholder="Google refresh token"
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
        <p className="font-medium text-slate-900">Notes</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>DB-stored connector credentials are used first for this org.</li>
          <li>Env vars remain fallback for local/dev when DB connector is missing.</li>
          <li>Credentials are stored in plain JSON for MVP; encryption at rest is future work.</li>
        </ul>
      </div>
    </section>
  );
}
