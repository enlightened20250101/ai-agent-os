import Link from "next/link";
import { postChannelMessage } from "@/app/app/chat/actions";
import { ChatShell } from "@/app/app/chat/ChatShell";
import { inviteChannelMember, leaveChannel, sendExternalDmEmail } from "@/app/app/chat/channels/actions";
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
    supabase
      .from("chat_channels")
      .select("id, name, description, channel_type, external_contact_id, created_at")
      .eq("org_id", orgId)
      .eq("id", id)
      .maybeSingle(),
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
  const channelType = (channelRes.data.channel_type as string | null) ?? "group";
  const externalContactId = (channelRes.data.external_contact_id as string | null) ?? null;
  const externalRes =
    externalContactId && channelType === "dm_external"
      ? await supabase
          .from("external_contacts")
          .select("id, display_name, email, company")
          .eq("org_id", orgId)
          .eq("id", externalContactId)
          .maybeSingle()
      : { data: null, error: null };
  if (externalRes.error && !externalRes.error.message.includes('relation "external_contacts" does not exist')) {
    throw new Error(`Failed to load external contact: ${externalRes.error.message}`);
  }

  const members = (membersRes.data ?? []) as Array<{ user_id: string; role: string; created_at: string }>;
  const [profilesRes, allMembersRes] = await Promise.all([
    supabase.from("user_profiles").select("user_id, display_name").eq("org_id", orgId).limit(500),
    supabase.from("memberships").select("user_id").eq("org_id", orgId).order("created_at", { ascending: true }).limit(500)
  ]);
  const profileNameByUserId = new Map(
    ((profilesRes.data ?? []) as Array<{ user_id: string; display_name: string | null }>)
      .map((row) => [row.user_id, row.display_name?.trim() ?? ""])
      .filter((row): row is [string, string] => Boolean(row[0]) && Boolean(row[1]))
  );
  const memberIds = new Set(members.map((row) => row.user_id));
  const inviteCandidates = ((allMembersRes.data ?? []) as Array<{ user_id: string }>)
    .map((row) => row.user_id)
    .filter((uid) => !memberIds.has(uid));
  const roleLabel = (role: string) => {
    if (role === "owner") return "オーナー";
    if (role === "admin") return "管理者";
    return "メンバー";
  };
  const channelTypeLabel = (value: string) => {
    if (value === "group") return "グループ";
    if (value === "dm_internal") return "社内DM";
    if (value === "dm_external") return "社外DM";
    return value;
  };
  const memberLabel = (uid: string) => profileNameByUserId.get(uid) ?? "表示名未設定メンバー";
  const sp = searchParams ? await searchParams : {};

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">チャンネル</p>
            <h1 className="text-xl font-semibold text-slate-900">#{channelRes.data.name as string}</h1>
            <p className="text-sm text-slate-600">{(channelRes.data.description as string | null) ?? "説明なし"}</p>
            <p className="text-xs text-slate-500">種別: {channelTypeLabel(channelType)}</p>
            {externalRes.data ? (
              <p className="text-xs text-slate-500">
                社外連絡先: {(externalRes.data.display_name as string) ?? "-"} /{" "}
                {(externalRes.data.company as string | null) ?? "会社名未設定"} / {(externalRes.data.email as string | null) ?? "メール未設定"}
              </p>
            ) : null}
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

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">運用ショートカット</p>
          <span className="text-xs text-slate-500">監査・例外対応への導線</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            href={`/app/executions?scope=channel&channel=${encodeURIComponent(id)}`}
            className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900 hover:bg-indigo-100"
          >
            このチャンネルの実行履歴
          </Link>
          <Link
            href="/app/chat/audit?scope=channel"
            className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 hover:bg-sky-100"
          >
            チャット監査（チャンネル）
          </Link>
          <Link
            href="/app/operations/exceptions"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900 hover:bg-rose-100"
          >
            例外キュー
          </Link>
          <Link
            href="/app/tasks"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100"
          >
            タスク一覧
          </Link>
        </div>
      </section>

      {channelType === "dm_external" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold text-slate-900">社外DM送信（Gmail）</p>
          <form action={sendExternalDmEmail} className="mt-3 space-y-2">
            <input type="hidden" name="channel_id" value={id} />
            <input name="subject" required placeholder="件名" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <textarea
              name="body_text"
              required
              rows={4}
              placeholder="本文"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800">
              送信
            </button>
          </form>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-900">メンバー招待</p>
        {inviteCandidates.length > 0 ? (
          <form action={inviteChannelMember} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="channel_id" value={id} />
            <select
              name="invite_user_id"
              required
              defaultValue=""
              className="min-w-[320px] rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">メンバーを選択</option>
              {inviteCandidates.map((uid) => (
                <option key={uid} value={uid}>
                  {memberLabel(uid)}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800">
              招待
            </button>
          </form>
        ) : (
          <p className="mt-3 text-sm text-slate-500">招待可能なメンバーはありません。</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {members.map((m) => (
            <span key={m.user_id} className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700">
              {memberLabel(m.user_id)} ({roleLabel(m.role)})
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
