"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrCreateChatSession } from "@/lib/chat/sessions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function toError(message: string) {
  return `/app/chat/channels?error=${encodeURIComponent(message)}`;
}

function toOk(message: string) {
  return `/app/chat/channels?ok=${encodeURIComponent(message)}`;
}

export async function createChatChannel(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!name) {
    redirect(toError("チャンネル名は必須です。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: channel, error } = await supabase
    .from("chat_channels")
    .insert({
      org_id: orgId,
      name,
      description: description.length > 0 ? description : null,
      created_by_user_id: userId
    })
    .select("id")
    .single();

  if (error) {
    redirect(toError(`チャンネル作成に失敗しました: ${error.message}`));
  }

  const channelId = channel.id as string;

  await supabase.from("chat_channel_members").insert({
    org_id: orgId,
    channel_id: channelId,
    user_id: userId,
    role: "owner"
  });

  await getOrCreateChatSession({
    supabase,
    orgId,
    scope: "channel",
    userId,
    channelId
  });

  revalidatePath("/app/chat/channels");
  redirect(`/app/chat/channels/${channelId}?ok=${encodeURIComponent("チャンネルを作成しました。")}`);
}

export async function inviteChannelMember(formData: FormData) {
  const channelId = String(formData.get("channel_id") ?? "").trim();
  const inviteUserId = String(formData.get("invite_user_id") ?? "").trim();
  if (!channelId || !inviteUserId) {
    redirect(toError("channel_id と invite_user_id が必要です。"));
  }

  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: membership } = await supabase
    .from("memberships")
    .select("id")
    .eq("org_id", orgId)
    .eq("user_id", inviteUserId)
    .maybeSingle();
  if (!membership) {
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent("指定ユーザーは同じワークスペースに所属していません。")}`);
  }

  const { error } = await supabase
    .from("chat_channel_members")
    .upsert(
      {
        org_id: orgId,
        channel_id: channelId,
        user_id: inviteUserId,
        role: "member"
      },
      { onConflict: "channel_id,user_id", ignoreDuplicates: false }
    );

  if (error) {
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent(`招待に失敗しました: ${error.message}`)}`);
  }

  revalidatePath(`/app/chat/channels/${channelId}`);
  revalidatePath("/app/chat/channels");
  redirect(`/app/chat/channels/${channelId}?ok=${encodeURIComponent("メンバーを招待しました。")}`);
}

export async function leaveChannel(formData: FormData) {
  const channelId = String(formData.get("channel_id") ?? "").trim();
  if (!channelId) {
    redirect(toError("channel_id が必要です。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { error } = await supabase
    .from("chat_channel_members")
    .delete()
    .eq("org_id", orgId)
    .eq("channel_id", channelId)
    .eq("user_id", userId);

  if (error) {
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent(`チャンネル退出に失敗しました: ${error.message}`)}`);
  }

  revalidatePath("/app/chat/channels");
  redirect(toOk("チャンネルから退出しました。"));
}
