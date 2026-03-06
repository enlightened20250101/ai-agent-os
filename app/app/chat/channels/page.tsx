import Link from "next/link";
import { createChatChannel, createDirectMessageChannel } from "@/app/app/chat/channels/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ChannelListPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

export default async function ChatChannelsPage({ searchParams }: ChannelListPageProps) {
  const sp = searchParams ? await searchParams : {};
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const [channelsRes, membersRes, profilesRes] = await Promise.all([
    supabase
      .from("chat_channel_members")
      .select("role, chat_channels!inner(id, name, description, channel_type, external_contact_id, created_at)")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    supabase.from("memberships").select("user_id").eq("org_id", orgId).order("created_at", { ascending: true }).limit(300),
    supabase.from("user_profiles").select("user_id, display_name, avatar_url").eq("org_id", orgId).limit(500)
  ]);
  const { data: channels, error } = channelsRes;
  if (membersRes.error) {
    throw new Error(`Failed to load members: ${membersRes.error.message}`);
  }
  if (profilesRes.error && !profilesRes.error.message.includes('relation "user_profiles" does not exist')) {
    throw new Error(`Failed to load profiles: ${profilesRes.error.message}`);
  }

  const profileMap = new Map(
    ((profilesRes.data ?? []) as Array<{ user_id: string; display_name: string | null; avatar_url: string | null }>).map((p) => [p.user_id, p])
  );
  const orgUsers = ((membersRes.data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id).filter((id) => id !== userId);

  if (error) {
    throw new Error(`Failed to load channels: ${error.message}`);
  }

  const rows = (channels ?? []).map((row) => {
    const channel = (row.chat_channels as unknown as Array<{
      id: string;
      name: string;
      description: string | null;
      channel_type: string | null;
      external_contact_id: string | null;
      created_at: string;
    }>)[0];
    return {
      role: (row.role as string) ?? "member",
      channel
    };
  });

  const dmChannelIds = rows
    .filter((row) => String(row.channel.channel_type ?? "").startsWith("dm_"))
    .map((row) => row.channel.id);
  const dmMembersRes =
    dmChannelIds.length > 0
      ? await supabase.from("chat_channel_members").select("channel_id, user_id").eq("org_id", orgId).in("channel_id", dmChannelIds)
      : { data: [], error: null };
  if (dmMembersRes.error) {
    throw new Error(`Failed to load DM members: ${dmMembersRes.error.message}`);
  }
  const dmPeerMap = new Map<string, string>();
  for (const member of (dmMembersRes.data ?? []) as Array<{ channel_id: string; user_id: string }>) {
    if (member.user_id === userId) continue;
    if (!dmPeerMap.has(member.channel_id)) {
      dmPeerMap.set(member.channel_id, member.user_id);
    }
  }

  const getDisplayName = (uid: string) => {
    const profile = profileMap.get(uid);
    const displayName = profile?.display_name?.trim();
    return displayName && displayName.length > 0 ? displayName : "表示名未設定メンバー";
  };
  const roleLabel = (role: string) => {
    if (role === "owner") return "オーナー";
    if (role === "admin") return "管理者";
    return "メンバー";
  };
  const channelCount = rows.filter((row) => !String(row.channel.channel_type ?? "").startsWith("dm_")).length;
  const dmCount = rows.length - channelCount;

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">チャンネル</h1>
            <p className="mt-2 text-sm text-slate-600">Slack風の会話画面です。AI実行は @AI を含む投稿だけが対象です。</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1">チャンネル {channelCount}</span>
            <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1">DM {dmCount}</span>
          </div>
        </div>
        {sp.ok ? <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{sp.ok}</p> : null}
        {sp.error ? <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p> : null}
        <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none text-sm font-medium text-slate-800">チャンネルを作成</summary>
          <form action={createChatChannel} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              type="text"
              name="name"
              required
              placeholder="例: accounting-ops"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
            <input type="text" name="description" placeholder="説明（任意）" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" />
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800">
              作成
            </button>
          </form>
        </details>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">参加中チャンネル</p>
            <Link href="/app/chat/shared" className="text-xs text-sky-700 hover:text-sky-800">
              共有チャットを開く
            </Link>
          </div>
          {rows.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">参加中のチャンネルはありません。</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {rows.map((row) => {
                const isDm = String(row.channel.channel_type ?? "").startsWith("dm_");
                const peerUserId = isDm ? dmPeerMap.get(row.channel.id) ?? null : null;
                const channelLabel = isDm && peerUserId ? getDisplayName(peerUserId) : row.channel.name;
                return (
                  <li key={row.channel.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">
                          {isDm ? "DM " : "#"}
                          {channelLabel}
                        </p>
                        <p className="text-xs text-slate-600">{row.channel.description ?? "説明なし"}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">{roleLabel(row.role)}</span>
                        <Link
                          href={`/app/chat/channels/${row.channel.id}`}
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          開く
                        </Link>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold text-slate-900">メンバーにDM</p>
          <p className="mt-1 text-xs text-slate-500">プロフィールから直接DMを開始できます。</p>
          {orgUsers.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">他のメンバーがいません。</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {orgUsers.map((uid) => {
                const label = getDisplayName(uid);
                const initial = label.slice(0, 1).toUpperCase();
                return (
                  <li key={uid} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
                        {initial}
                      </span>
                      <p className="truncate text-sm font-medium text-slate-900">{label}</p>
                    </div>
                    <form action={createDirectMessageChannel}>
                      <input type="hidden" name="target_user_id" value={uid} />
                      <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
                        DM作成
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
