import Link from "next/link";
import { createChatChannel } from "@/app/app/chat/channels/actions";
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

  const { data: channels, error } = await supabase
    .from("chat_channel_members")
    .select("role, chat_channels!inner(id, name, description, created_at)")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load channels: ${error.message}`);
  }

  const rows = (channels ?? []).map((row) => ({
    role: (row.role as string) ?? "member",
    channel: (row.chat_channels as unknown as { id: string; name: string; description: string | null; created_at: string }[])[0]
  }));

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
