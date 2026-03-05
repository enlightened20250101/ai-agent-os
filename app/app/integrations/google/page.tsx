import Link from "next/link";
import { headers } from "next/headers";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import { CopyButton } from "@/app/app/integrations/google/CopyButton";
import { disconnectGoogleConnector } from "@/app/app/integrations/google/actions";
import { getConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import { getGoogleEnvStatus } from "@/lib/connectors/runtime";
import { getGoogleRedirectUri, getNormalizedAppBaseUrl } from "@/lib/google/oauth";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type GoogleIntegrationPageProps = {
  searchParams?: Promise<{
    ok?: string;
    error?: string;
    error_description?: string;
    error_id?: string;
    success?: string;
    message?: string;
  }>;
};

export default async function GoogleIntegrationPage({ searchParams }: GoogleIntegrationPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const envStatus = getGoogleEnvStatus();
  const connector = await getConnectorAccount({ supabase, orgId, provider: "google" });
  const headersStore = await headers();
  const currentHost = headersStore.get("x-forwarded-host") ?? headersStore.get("host") ?? "";
  const appBaseUrl = getNormalizedAppBaseUrl();
  const redirectUri = getGoogleRedirectUri();
  const dbSecrets = (connector?.secrets_json ?? {}) as Record<string, unknown>;
  const dbStatus = {
    refreshToken: typeof dbSecrets.refresh_token === "string" && dbSecrets.refresh_token.length > 0,
    senderEmail: typeof dbSecrets.sender_email === "string" && dbSecrets.sender_email.length > 0
  };
  const senderEmail =
    (typeof dbSecrets.sender_email === "string" && dbSecrets.sender_email) || connector?.external_account_id;
  const connected = Boolean(dbStatus.refreshToken && senderEmail);
  const sp = searchParams ? await searchParams : {};
  const okMessage = sp.ok ?? (sp.success === "1" ? "Googleコネクタの接続に成功しました。" : undefined);
  const errorMessage = sp.error
    ? `${sp.error}${sp.error_description ? `: ${sp.error_description}` : ""}${sp.error_id ? ` (error_id: ${sp.error_id})` : ""}`
    : undefined;
  const shouldWarnDomain =
    appBaseUrl.includes("ngrok") &&
    (currentHost.includes("localhost") || currentHost.includes("127.0.0.1"));

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold">Google 連携</h1>
        <p className="mt-2 text-sm text-slate-600">
          この組織のGmailをOAuthで接続します。クライアント認証情報はサーバー環境変数で管理されます。
        </p>
      </div>

      <StatusNotice ok={okMessage} error={errorMessage} />
      {shouldWarnDomain ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          セッション/ドメイン問題を避けるため、ngrokドメインからOAuthを開始してください。
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">接続状態</p>
          <p className={connected ? "text-emerald-700" : "text-rose-700"}>
            {connected ? "接続済み" : "未接続"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">接続済み送信元</p>
          <p className="text-slate-700">{senderEmail || "（なし）"}</p>
          <p className="mt-1 text-xs text-slate-500">
            connected_at: {connector?.created_at ? new Date(connector.created_at).toLocaleString() : "（n/a）"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm md:col-span-2">
          <p className="font-medium">検出された APP_BASE_URL</p>
          <p className="text-slate-700 break-all">{appBaseUrl}</p>
          <p className="mt-2 font-medium">計算された redirect_uri</p>
          <div className="mt-1 flex items-center gap-2">
            <p className="text-slate-700 break-all">{redirectUri}</p>
            <CopyButton value={redirectUri} />
          </div>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">サーバー OAuth env</p>
          <p className={envStatus.clientId && envStatus.clientSecret ? "text-emerald-700" : "text-rose-700"}>
            {envStatus.clientId && envStatus.clientSecret ? "設定済み" : "未設定"}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 p-3 text-sm">
          <p className="font-medium">旧envフォールバックトークン</p>
          <p className={envStatus.clientId && envStatus.clientSecret && envStatus.refreshToken && envStatus.senderEmail ? "text-emerald-700" : "text-amber-700"}>
            {envStatus.clientId && envStatus.clientSecret && envStatus.refreshToken && envStatus.senderEmail
              ? "設定完了"
              : "不足あり"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/api/google/auth"
          className="rounded-md bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {connected ? "Googleを再接続" : "Googleを接続"}
        </Link>
        {connected ? (
          <form action={disconnectGoogleConnector}>
            <ConfirmSubmitButton
              label="切断"
              pendingLabel="切断中..."
              confirmMessage="この組織のGoogle接続を切断します。実行しますか？"
              className="rounded-md border border-rose-300 px-4 py-2 text-sm text-rose-700 hover:bg-rose-50"
            />
          </form>
        ) : null}
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium text-slate-900">OAuth設定</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>`APP_BASE_URL` を到達可能なURLに設定してください（ローカルHTTPS検証時はngrok URL）。</li>
          <li>Google OAuth redirect URI は `{(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/api/google/callback` を設定してください。</li>
          <li>OAuthで取得した `refresh_token` と sender email は組織単位で `connector_accounts` に保存されます。</li>
          <li>MVPでは秘密情報はDBに平文JSONで保存します（`future`: 保存時暗号化）。</li>
        </ul>
      </div>
    </section>
  );
}
