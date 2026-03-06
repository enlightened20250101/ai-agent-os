import { CopyButton } from "@/app/app/integrations/google/CopyButton";
import { createWorkspaceInviteLink, revokeWorkspaceInviteLink, updateLocale, updateProfile } from "@/app/app/settings/actions";
import { getAppBaseUrl } from "@/lib/app/baseUrl";
import { getAppLocale } from "@/lib/i18n/locale";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type SettingsPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string; invite_url?: string }>;
};

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const locale = await getAppLocale();
  const sp = searchParams ? await searchParams : {};
  const isEn = locale === "en";
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const { data: profileRes, error: profileError } = await supabase
    .from("user_profiles")
    .select("display_name, avatar_url, job_title")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  const missingProfileTable =
    profileError &&
    (profileError.message.includes('relation "user_profiles" does not exist') ||
      profileError.message.includes("Could not find the table 'public.user_profiles'"));
  if (profileError && !missingProfileTable) {
    throw new Error(`Failed to load profile: ${profileError.message}`);
  }
  const profile = (profileRes ?? null) as {
    display_name: string | null;
    avatar_url: string | null;
    job_title: string | null;
  } | null;
  const inviteLinksRes = await supabase
    .from("org_invite_links")
    .select("id, token, expires_at, used_count, max_uses, created_at")
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(10);
  const missingInviteTable =
    inviteLinksRes.error &&
    (inviteLinksRes.error.message.includes('relation "org_invite_links" does not exist') ||
      inviteLinksRes.error.message.includes("Could not find the table 'public.org_invite_links'"));
  if (inviteLinksRes.error && !missingInviteTable) {
    throw new Error(`Failed to load invite links: ${inviteLinksRes.error.message}`);
  }
  const inviteLinks = (inviteLinksRes.data ?? []) as Array<{
    id: string;
    token: string;
    expires_at: string;
    used_count: number;
    max_uses: number;
    created_at: string;
  }>;
  const appBaseUrl = getAppBaseUrl();

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">{isEn ? "Settings" : "設定"}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {isEn ? "Manage language and display preferences." : "言語や表示設定を管理します。"}
        </p>
      </header>

      {sp.ok === "language_updated" ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {isEn ? "Language updated." : "言語を更新しました。"}
        </p>
      ) : null}
      {sp.ok === "profile_updated" ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {isEn ? "Profile updated." : "プロフィールを更新しました。"}
        </p>
      ) : null}
      {sp.ok === "invite_created" ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {isEn ? "Invite link created." : "招待リンクを作成しました。"}
        </p>
      ) : null}
      {sp.ok === "invite_revoked" ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {isEn ? "Invite link revoked." : "招待リンクを無効化しました。"}
        </p>
      ) : null}
      {sp.error ? <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p> : null}

      <form action={updateLocale} className="max-w-sm space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <input type="hidden" name="return_to" value="/app/settings" />
        <label htmlFor="locale" className="block text-sm font-medium text-slate-800">
          {isEn ? "Language" : "言語"}
        </label>
        <select
          id="locale"
          name="locale"
          defaultValue={locale}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="ja">日本語</option>
          <option value="en">English</option>
        </select>
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          {isEn ? "Save" : "保存"}
        </button>
      </form>

      <form action={updateProfile} className="max-w-sm space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <label htmlFor="display_name" className="block text-sm font-medium text-slate-800">
          {isEn ? "Display Name" : "表示名"}
        </label>
        <input
          id="display_name"
          name="display_name"
          defaultValue={profile?.display_name ?? ""}
          placeholder={isEn ? "e.g. Hiroki" : "例: Hiroki"}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <label htmlFor="job_title" className="block text-sm font-medium text-slate-800">
          {isEn ? "Job Title" : "役職"}
        </label>
        <input
          id="job_title"
          name="job_title"
          defaultValue={profile?.job_title ?? ""}
          placeholder={isEn ? "e.g. Finance Manager" : "例: 経理マネージャー"}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <label htmlFor="avatar_file" className="block text-sm font-medium text-slate-800">
          {isEn ? "Avatar Image" : "プロフィール画像"}
        </label>
        <input id="avatar_file" name="avatar_file" type="file" accept="image/*" className="w-full text-sm" />
        {profile?.avatar_url ? <p className="text-xs text-slate-500">画像登録済み</p> : null}
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          {isEn ? "Save Profile" : "プロフィール保存"}
        </button>
      </form>

      <section className="max-w-2xl space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h2 className="text-sm font-semibold text-slate-900">{isEn ? "Workspace Invite Links" : "ワークスペース招待リンク"}</h2>
        <p className="text-xs text-slate-600">
          {isEn
            ? "Create an invite link to let teammates join this workspace."
            : "同じワークスペースへ参加してもらうための招待リンクを発行します。"}
        </p>
        <form action={createWorkspaceInviteLink}>
          <input type="hidden" name="return_to" value="/app/settings" />
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
            {isEn ? "Create Invite Link" : "招待リンクを作成"}
          </button>
        </form>
        {sp.invite_url ? (
          <div className="rounded-md border border-sky-200 bg-sky-50 p-3">
            <p className="text-xs font-medium text-sky-900">{isEn ? "Latest invite URL" : "最新の招待URL"}</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="break-all text-xs text-sky-800">{sp.invite_url}</p>
              <CopyButton value={sp.invite_url} />
            </div>
          </div>
        ) : null}
        {inviteLinks.length > 0 ? (
          <ul className="space-y-2 text-xs text-slate-700">
            {inviteLinks.map((link) => {
              const inviteUrl = `${appBaseUrl}/invite/${encodeURIComponent(link.token)}`;
              return (
                <li key={link.id} className="rounded-md border border-slate-200 bg-white p-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="break-all font-medium text-slate-900">{inviteUrl}</p>
                    <CopyButton value={inviteUrl} />
                  </div>
                  <p className="mt-1 text-slate-500">
                    有効期限: {new Date(link.expires_at).toLocaleString("ja-JP")} | 利用回数: {link.used_count}/{link.max_uses}
                  </p>
                  <form action={revokeWorkspaceInviteLink} className="mt-2">
                    <input type="hidden" name="invite_id" value={link.id} />
                    <input type="hidden" name="return_to" value="/app/settings" />
                    <button
                      type="submit"
                      className="rounded-md border border-rose-300 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50"
                    >
                      {isEn ? "Revoke" : "無効化"}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">{isEn ? "No invite links yet." : "招待リンクはまだありません。"}</p>
        )}
      </section>
    </section>
  );
}
