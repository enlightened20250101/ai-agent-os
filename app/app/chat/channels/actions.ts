"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveGoogleRuntimeConfig } from "@/lib/connectors/runtime";
import { appendAiExecutionLog } from "@/lib/executions/logs";
import { sendEmailWithGmail } from "@/lib/google/gmail";
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
      redirect(toError("有効なユーザーを指定してください。"));
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

    const { data: myDmMemberships, error: myDmMembershipsError } = await supabase
      .from("chat_channel_members")
      .select("channel_id, chat_channels!inner(id, channel_type)")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .eq("chat_channels.channel_type", "dm_internal");
    if (myDmMembershipsError) {
      redirect(toError(`既存DMの確認に失敗しました: ${myDmMembershipsError.message}`));
    }

    const candidateChannelIds = ((myDmMemberships ?? []) as Array<{ channel_id: string }>).map((row) => row.channel_id);
    if (candidateChannelIds.length > 0) {
      const { data: candidateMembers, error: candidateMembersError } = await supabase
        .from("chat_channel_members")
        .select("channel_id, user_id")
        .eq("org_id", orgId)
        .in("channel_id", candidateChannelIds);
      if (candidateMembersError) {
        redirect(toError(`既存DMの照合に失敗しました: ${candidateMembersError.message}`));
      }

      const memberSets = new Map<string, Set<string>>();
      for (const row of (candidateMembers ?? []) as Array<{ channel_id: string; user_id: string }>) {
        const existing = memberSets.get(row.channel_id) ?? new Set<string>();
        existing.add(row.user_id);
        memberSets.set(row.channel_id, existing);
      }

      for (const [channelId, members] of memberSets.entries()) {
        if (members.size === 2 && members.has(userId) && members.has(targetUserId)) {
          redirect(`/app/chat/channels/${channelId}?ok=${encodeURIComponent("既存のDMを開きました。")}`);
        }
      }
    }

    const { data: channel, error } = await supabase
      .from("chat_channels")
      .insert({
        org_id: orgId,
        name: `dm-${userId.slice(0, 6)}-${targetUserId.slice(0, 6)}`,
        description: "direct message",
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
    redirect(`/app/chat/channels/${channelId}?ok=${encodeURIComponent("DMを作成しました。")}`);
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

export async function sendExternalDmEmail(formData: FormData) {
  const channelId = String(formData.get("channel_id") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const bodyText = String(formData.get("body_text") ?? "").trim();
  if (!channelId || !subject || !bodyText) {
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent("件名と本文は必須です。")}`);
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const { data: channel, error: channelError } = await supabase
    .from("chat_channels")
    .select("id, channel_type, external_contact_id, name")
    .eq("org_id", orgId)
    .eq("id", channelId)
    .maybeSingle();
  if (channelError || !channel) {
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent("チャンネルが見つかりません。")}`);
  }
  if ((channel.channel_type as string) !== "dm_external" || !(channel.external_contact_id as string | null)) {
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent("このチャンネルは社外DM送信対象ではありません。")}`);
  }

  const { data: contact, error: contactError } = await supabase
    .from("external_contacts")
    .select("id, display_name, email")
    .eq("org_id", orgId)
    .eq("id", channel.external_contact_id as string)
    .maybeSingle();
  if (contactError || !contact || !(contact.email as string | null)) {
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent("社外連絡先メールが未設定です。")}`);
  }

  const cfg = await resolveGoogleRuntimeConfig({ supabase, orgId });
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken || !cfg.senderEmail) {
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent("Googleコネクタが未設定です。")}`);
  }

  try {
    const res = await sendEmailWithGmail({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: cfg.refreshToken,
      senderEmail: cfg.senderEmail,
      to: contact.email as string,
      subject,
      bodyText
    });

    const session = await getOrCreateChatSession({ supabase, orgId, scope: "channel", userId, channelId });
    await supabase.from("chat_messages").insert({
      org_id: orgId,
      session_id: session.id,
      sender_type: "system",
      body_text: `社外送信しました: to=${contact.email as string}, subject=${subject}`,
      metadata_json: {
        source: "external_dm_send",
        external_contact_id: contact.id,
        gmail_message_id: res.messageId
      }
    });
    await appendAiExecutionLog({
      supabase,
      orgId,
      triggeredByUserId: userId,
      sessionId: session.id,
      sessionScope: "channel",
      channelId,
      intentType: "external_dm_send",
      executionStatus: "done",
      executionRefType: "channel",
      executionRefId: channelId,
      source: "external_dm",
      summaryText: `External DM sent to ${contact.email as string}`,
      metadata: {
        contact_id: contact.id,
        contact_name: contact.display_name,
        to: contact.email,
        subject,
        gmail_message_id: res.messageId,
        stubbed: res.stubbed
      },
      finishedAt: new Date().toISOString()
    });
    revalidatePath(`/app/chat/channels/${channelId}`);
    revalidatePath("/app/executions");
    redirect(`/app/chat/channels/${channelId}?ok=${encodeURIComponent("社外DMを送信しました。")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "送信に失敗しました。";
    await appendAiExecutionLog({
      supabase,
      orgId,
      triggeredByUserId: userId,
      sessionScope: "channel",
      channelId,
      intentType: "external_dm_send",
      executionStatus: "failed",
      executionRefType: "channel",
      executionRefId: channelId,
      source: "external_dm",
      summaryText: `External DM failed: ${message}`,
      metadata: { error: message, subject, to: contact.email },
      finishedAt: new Date().toISOString()
    });
    revalidatePath("/app/executions");
    redirect(`/app/chat/channels/${channelId}?error=${encodeURIComponent(`社外DM送信失敗: ${message}`)}`);
  }
}
