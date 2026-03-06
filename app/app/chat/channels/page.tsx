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

  const [channelsRes, membersRes, contactsRes] = await Promise.all([
    supabase
      .from("chat_channel_members")
      .select("role, chat_channels!inner(id, name, description, channel_type, external_contact_id, created_at)")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    supabase.from("memberships").select("user_id").eq("org_id", orgId).order("created_at", { ascending: true }).limit(300),
    supabase
      .from("external_contacts")
      .select("id, display_name, company")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(200)
  ]);
  const { data: channels, error } = channelsRes;
  if (membersRes.error) {
    throw new Error(`Failed to load members: ${membersRes.error.message}`);
  }
  if (contactsRes.error && !contactsRes.error.message.includes('relation "external_contacts" does not exist')) {
    throw new Error(`Failed to load external contacts: ${contactsRes.error.message}`);
  }

  const contactMap = new Map(
    ((contactsRes.data ?? []) as Array<{ id: string; display_name: string; company: string | null }>).map((c) => [c.id, c])
  );
  const orgUsers = ((membersRes.data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);

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
    const external = channel.external_contact_id ? contactMap.get(channel.external_contact_id) ?? null : null;
    return {
      role: (row.role as string) ?? "member",
      channel,
      external
    };
  });

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">チャンネル</h1>
        <p className="mt-2 text-sm text-slate-600">Slack風の会話チャンネルです。@AI を付けた発言のみAI実行されます。</p>
        {sp.ok ? <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{sp.ok}</p> : null}
        {sp.error ? <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p> : null}
      </header>

      <form action={createChatChannel} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-900">チャンネル作成</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <input
            type="text"
            name="name"
            required
            placeholder="例: accounting-ops"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input type="text" name="description" placeholder="説明（任意）" className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2" />
        </div>
        <button type="submit" className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          作成
        </button>
      </form>

      <form action={createDirectMessageChannel} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-900">DM作成（社内/社外）</p>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <select name="dm_kind" defaultValue="internal" className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="internal">社内DM</option>
            <option value="external">社外DM</option>
          </select>
          <select name="target_user_id" className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="">社内ユーザー選択</option>
            {orgUsers.map((uid) => (
              <option key={uid} value={uid}>
                {uid}
              </option>
            ))}
          </select>
          <select name="external_contact_id" className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="">社外連絡先選択</option>
            {((contactsRes.data ?? []) as Array<{ id: string; display_name: string; company: string | null }>).map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name} {c.company ? `(${c.company})` : ""}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          DM作成
        </button>
      </form>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-900">参加中チャンネル</p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">参加中のチャンネルはありません。</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <li key={row.channel.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">#{row.channel.name}</p>
                    <p className="text-xs text-slate-600">{row.channel.description ?? "説明なし"}</p>
                    <p className="text-[11px] text-slate-500">
                      type: {row.channel.channel_type ?? "group"}
                      {row.external ? ` | external: ${row.external.display_name}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">{row.role}</span>
                    <Link href={`/app/chat/channels/${row.channel.id}`} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
                      開く
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
