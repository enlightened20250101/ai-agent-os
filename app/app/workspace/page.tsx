import Link from "next/link";
import Image from "next/image";
import { CopyButton } from "@/app/app/integrations/google/CopyButton";
import { createWorkspaceInviteLink, revokeWorkspaceInviteLink } from "@/app/app/settings/actions";
import { getAppBaseUrl } from "@/lib/app/baseUrl";
import { getAppLocale } from "@/lib/i18n/locale";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function isMissingTableError(message: string, tableName: string) {
  return message.includes(`relation "${tableName}" does not exist`) || message.includes(`Could not find the table 'public.${tableName}'`);
}

type MemberRow = {
  user_id: string;
  role: string;
  created_at: string;
};

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  mention_handle: string | null;
  avatar_url: string | null;
};

type InviteRow = {
  id: string;
  token: string;
  expires_at: string;
  used_count: number;
  max_uses: number;
  created_at: string;
};

function memberRoleLabel(role: string, isEn: boolean) {
  if (isEn) {
    if (role === "owner") return "Owner";
    if (role === "admin") return "Admin";
    return "Member";
  }
  if (role === "owner") return "オーナー";
  if (role === "admin") return "管理者";
  return "メンバー";
}

type WorkspacePageProps = {
  searchParams?: Promise<{ ok?: string; error?: string; invite_url?: string }>;
};

export default async function WorkspacePage({ searchParams }: WorkspacePageProps) {
  const locale = await getAppLocale();
  const sp = searchParams ? await searchParams : {};
  const isEn = locale === "en";
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const appBaseUrl = getAppBaseUrl();

  const [orgRes, membersRes, profilesRes, inviteLinksRes] = await Promise.all([
    supabase.from("orgs").select("name, created_at").eq("id", orgId).maybeSingle(),
    supabase.from("memberships").select("user_id, role, created_at").eq("org_id", orgId).order("created_at", { ascending: true }).limit(500),
    supabase.from("user_profiles").select("user_id, display_name, mention_handle, avatar_url").eq("org_id", orgId).limit(500),
    supabase
      .from("org_invite_links")
      .select("id, token, expires_at, used_count, max_uses, created_at")
      .eq("org_id", orgId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(10)
  ]);

  if (orgRes.error) {
    throw new Error(`Failed to load workspace: ${orgRes.error.message}`);
  }
  if (membersRes.error) {
    throw new Error(`Failed to load members: ${membersRes.error.message}`);
  }
  if (profilesRes.error && !isMissingTableError(profilesRes.error.message, "user_profiles")) {
    throw new Error(`Failed to load member profiles: ${profilesRes.error.message}`);
  }
  if (inviteLinksRes.error && !isMissingTableError(inviteLinksRes.error.message, "org_invite_links")) {
    throw new Error(`Failed to load invite links: ${inviteLinksRes.error.message}`);
  }

  const members = (membersRes.data ?? []) as MemberRow[];
  const profiles = (profilesRes.data ?? []) as ProfileRow[];
  const inviteLinks = (inviteLinksRes.data ?? []) as InviteRow[];
  const profileMap = new Map(profiles.map((row) => [row.user_id, row]));

  const ownerCount = members.filter((row) => row.role === "owner").length;
  const adminCount = members.filter((row) => row.role === "admin").length;
  const memberCount = members.filter((row) => row.role !== "owner" && row.role !== "admin").length;

  return (
    <section className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-teal-900 p-6 text-white shadow-lg">
        <p className="text-xs uppercase tracking-[0.18em] text-teal-200">{isEn ? "Workspace" : "ワークスペース"}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{(orgRes.data?.name as string | null) ?? (isEn ? "Unnamed Workspace" : "名称未設定")}</h1>
        <p className="mt-2 text-sm text-slate-200">
          {isEn
            ? "Manage members and invite links for your shared team workspace."
            : "共有ワークスペースのメンバーと招待リンクを確認・管理します。"}
        </p>
        <p className="mt-4 inline-flex rounded-full border border-white/30 bg-white/10 px-3 py-1 text-xs text-slate-100">
          {isEn ? "Created at" : "作成日"}:{" "}
          {orgRes.data?.created_at ? new Date(orgRes.data.created_at as string).toLocaleString("ja-JP") : "-"}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/app/settings" className="rounded-md border border-white/30 bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20">
            {isEn ? "Open Settings" : "設定を開く"}
          </Link>
          <Link href="/app/chat/channels" className="rounded-md border border-white/30 bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20">
            {isEn ? "Open Channels" : "チャンネルを開く"}
          </Link>
        </div>
      </section>

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

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-600">{isEn ? "Members" : "メンバー数"}</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{members.length}</p>
          <p className="mt-1 text-[11px] text-slate-500">{isEn ? `General members: ${memberCount}` : `一般メンバー: ${memberCount}`}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <p className="text-xs text-amber-700">{isEn ? "Owners/Admins" : "管理者（owner/admin）"}</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">{ownerCount + adminCount}</p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-xs text-sky-700">{isEn ? "Active Invite Links" : "有効な招待リンク"}</p>
          <p className="mt-1 text-2xl font-semibold text-sky-900">{inviteLinks.length}</p>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">{isEn ? "Members" : "メンバー一覧"}</h2>
          <Link href="/app/settings" className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100">
            {isEn ? "Manage in Settings" : "設定で管理"}
          </Link>
        </div>
        {members.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {members.map((member) => {
              const profile = profileMap.get(member.user_id);
              const displayName = profile?.display_name?.trim() || (isEn ? "Member" : "メンバー");
              const handle = profile?.mention_handle?.trim() ? `@${profile.mention_handle}` : null;
              const avatarInitial = displayName.slice(0, 1).toUpperCase();
              return (
                <li key={`${member.user_id}-${member.created_at}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    {profile?.avatar_url ? (
                      <Image src={profile.avatar_url} alt={displayName} width={24} height={24} unoptimized className="h-6 w-6 rounded-full object-cover" />
                    ) : (
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
                        {avatarInitial}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900">
                        {displayName}
                        {member.user_id === userId ? (
                          <span className="ml-1 text-[11px] font-normal text-slate-500">({isEn ? "you" : "あなた"})</span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {handle ?? (isEn ? "handle not set" : "ハンドル未設定")}
                      </p>
                    </div>
                  </div>
                  <div className="text-right text-xs">
                    <p className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-slate-700">{memberRoleLabel(member.role, isEn)}</p>
                    <p className="mt-1 text-slate-500">{new Date(member.created_at).toLocaleDateString("ja-JP")}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">{isEn ? "No members found." : "メンバーが見つかりません。"}</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">{isEn ? "Invite Links" : "招待リンク"}</h2>
          <form action={createWorkspaceInviteLink}>
            <input type="hidden" name="return_to" value="/app/workspace" />
            <button type="submit" className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100">
              {isEn ? "Create Invite Link" : "招待リンクを作成"}
            </button>
          </form>
        </div>
        {sp.invite_url ? (
          <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 p-3">
            <p className="text-xs font-medium text-sky-900">{isEn ? "Latest invite URL" : "最新の招待URL"}</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="break-all text-xs text-sky-800">{sp.invite_url}</p>
              <CopyButton value={sp.invite_url} />
            </div>
          </div>
        ) : null}
        {inviteLinks.length > 0 ? (
          <ul className="mt-4 space-y-2 text-xs text-slate-700">
            {inviteLinks.map((link) => {
              const inviteUrl = `${appBaseUrl}/invite/${encodeURIComponent(link.token)}`;
              return (
                <li key={link.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="break-all font-medium text-slate-900">{inviteUrl}</p>
                    <CopyButton value={inviteUrl} />
                  </div>
                  <p className="mt-1 text-slate-500">
                    {isEn ? "Expires" : "有効期限"}: {new Date(link.expires_at).toLocaleString("ja-JP")} |{" "}
                    {isEn ? "Uses" : "利用回数"}: {link.used_count}/{link.max_uses}
                  </p>
                  <form action={revokeWorkspaceInviteLink} className="mt-2">
                    <input type="hidden" name="invite_id" value={link.id} />
                    <input type="hidden" name="return_to" value="/app/workspace" />
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
          <p className="mt-3 text-sm text-slate-600">
            {isEn ? "No active invite links. Create one from Settings." : "有効な招待リンクはありません。設定ページで作成できます。"}
          </p>
        )}
      </section>
    </section>
  );
}
