import Link from "next/link";
import { postChannelMessage } from "@/app/app/chat/actions";
import { ChatShell } from "@/app/app/chat/ChatShell";
import { inviteChannelMember, leaveChannel } from "@/app/app/chat/channels/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ChannelPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ ok?: string; error?: string; cmd_status?: string }>;
};

export default async function ChatChannelDetailPage({ params, searchParams }: ChannelPageProps) {
  const { id } = await params;
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const [channelRes, membersRes] = await Promise.all([
    supabase.from("chat_channels").select("id, name, description, created_at").eq("org_id", orgId).eq("id", id).maybeSingle(),
    supabase
      .from("chat_channel_members")
      .select("user_id, role, created_at")
      .eq("org_id", orgId)
      .eq("channel_id", id)
      .order("created_at", { ascending: true })
      .limit(200)
  ]);

  if (channelRes.error) {
    throw new Error(`Failed to load channel: ${channelRes.error.message}`);
  }
  if (!channelRes.data) {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
        チャンネルが見つからないか、アクセス権がありません。
      </section>
    );
  }
  if (membersRes.error) {
    throw new Error(`Failed to load channel members: ${membersRes.error.message}`);
  }

  const members = (membersRes.data ?? []) as Array<{ user_id: string; role: string; created_at: string }>;
  const sp = searchParams ? await searchParams : {};

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Channel</p>
            <h1 className="text-xl font-semibold text-slate-900">#{channelRes.data.name as string}</h1>
            <p className="text-sm text-slate-600">{(channelRes.data.description as string | null) ?? "説明なし"}</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/app/chat/channels" className="rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50">
              チャンネル一覧
            </Link>
            <form action={leaveChannel}>
              <input type="hidden" name="channel_id" value={id} />
              <button type="submit" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 hover:bg-rose-100">
                退出
              </button>
            </form>
          </div>
        </div>
        {sp.ok ? <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{sp.ok}</p> : null}
        {sp.error ? <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p> : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-900">メンバー招待（同じworkspace内の user_id）</p>
        <form action={inviteChannelMember} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="channel_id" value={id} />
          <input
            type="text"
            name="invite_user_id"
            required
            placeholder="user_id"
            className="min-w-[320px] rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800">
            招待
          </button>
        </form>
        <p className="mt-2 text-xs text-slate-500">MVPでは user_id 指定で招待します（email招待は future）。</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {members.map((m) => (
            <span key={m.user_id} className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700">
              {m.user_id} ({m.role})
            </span>
          ))}
        </div>
      </section>

      <ChatShell
        scope="channel"
        channelId={id}
        title={`#${channelRes.data.name as string}`}
        description="チャンネル会話です。@AI を付けた発言のみAI実行されます。"
        submitAction={postChannelMessage}
        searchParams={searchParams}
      />
    </div>
  );
}
