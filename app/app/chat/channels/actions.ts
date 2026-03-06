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

export async function createDirectMessageChannel(formData: FormData) {
  const dmKind = String(formData.get("dm_kind") ?? "internal").trim();
  const targetUserId = String(formData.get("target_user_id") ?? "").trim();
  const externalContactId = String(formData.get("external_contact_id") ?? "").trim();

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  if (dmKind === "internal") {
    if (!targetUserId || targetUserId === userId) {
      redirect(toError("有効な社内ユーザーIDを指定してください。"));
    }
    const { data: targetMembership } = await supabase
      .from("memberships")
      .select("id")
      .eq("org_id", orgId)
      .eq("user_id", targetUserId)
      .maybeSingle();
    if (!targetMembership) {
      redirect(toError("対象ユーザーは同じワークスペースに所属していません。"));
    }

    const { data: channel, error } = await supabase
      .from("chat_channels")
      .insert({
        org_id: orgId,
        name: `dm-${userId.slice(0, 6)}-${targetUserId.slice(0, 6)}`,
        description: "internal DM",
        created_by_user_id: userId,
        channel_type: "dm_internal"
      })
      .select("id")
      .single();
    if (error) {
      redirect(toError(`DM作成に失敗しました: ${error.message}`));
    }
    const channelId = channel.id as string;
    await supabase.from("chat_channel_members").insert([
      { org_id: orgId, channel_id: channelId, user_id: userId, role: "owner" },
      { org_id: orgId, channel_id: channelId, user_id: targetUserId, role: "member" }
    ]);
    await getOrCreateChatSession({ supabase, orgId, scope: "channel", userId, channelId });
    revalidatePath("/app/chat/channels");
    redirect(`/app/chat/channels/${channelId}?ok=${encodeURIComponent("社内DMを作成しました。")}`);
  }

  if (!externalContactId) {
    redirect(toError("社外連絡先を指定してください。"));
  }
  const { data: external } = await supabase
    .from("external_contacts")
    .select("id, display_name")
    .eq("org_id", orgId)
    .eq("id", externalContactId)
    .maybeSingle();
  if (!external) {
    redirect(toError("社外連絡先が見つかりません。"));
  }
  const { data: channel, error } = await supabase
    .from("chat_channels")
    .insert({
      org_id: orgId,
      name: `ext-${String(external.display_name).replace(/\s+/g, "-").toLowerCase()}`,
      description: `external DM: ${external.display_name as string}`,
      created_by_user_id: userId,
      channel_type: "dm_external",
      external_contact_id: externalContactId
    })
    .select("id")
    .single();
  if (error) {
    redirect(toError(`社外DM作成に失敗しました: ${error.message}`));
  }
  const channelId = channel.id as string;
  await supabase.from("chat_channel_members").insert({
    org_id: orgId,
    channel_id: channelId,
    user_id: userId,
    role: "owner"
  });
  await getOrCreateChatSession({ supabase, orgId, scope: "channel", userId, channelId });
  revalidatePath("/app/chat/channels");
  redirect(`/app/chat/channels/${channelId}?ok=${encodeURIComponent("社外DMを作成しました。")}`);
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
