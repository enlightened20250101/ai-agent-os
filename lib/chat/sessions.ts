import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingChatSchemaError } from "@/lib/chat/schema";

export type ChatScope = "shared" | "personal" | "channel";

export async function getOrCreateChatSession(args: {
  supabase: SupabaseClient;
  orgId: string;
  scope: ChatScope;
  userId: string;
  channelId?: string | null;
}) {
  const { supabase, orgId, scope, userId, channelId = null } = args;
  let query = supabase
    .from("chat_sessions")
    .select("id, scope, owner_user_id, title, channel_id")
    .eq("org_id", orgId)
    .eq("scope", scope)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (scope === "personal") {
    query = query.eq("owner_user_id", userId);
  } else if (scope === "channel") {
    if (!channelId) {
      throw new Error("channelId is required for channel scope");
    }
    query = query.eq("channel_id", channelId);
  }

  const { data: existing, error: lookupError } = await query.maybeSingle();
  if (lookupError) {
    if (isMissingChatSchemaError(lookupError.message)) {
      throw new Error(`chat schema missing: ${lookupError.message}`);
    }
    throw new Error(`chat session lookup failed: ${lookupError.message}`);
  }
  if (existing?.id) {
    return {
      id: existing.id as string,
      scope: existing.scope as ChatScope,
      ownerUserId: (existing.owner_user_id as string | null) ?? null,
      title: (existing.title as string | null) ?? "chat",
      channelId: (existing.channel_id as string | null) ?? null
    };
  }

  const { data: created, error: createError } = await supabase
    .from("chat_sessions")
    .insert({
      org_id: orgId,
      scope,
      owner_user_id: scope === "personal" ? userId : null,
      channel_id: scope === "channel" ? channelId : null,
      title: scope === "personal" ? "my-chat" : scope === "channel" ? "channel-chat" : "shared-chat"
    })
    .select("id, scope, owner_user_id, title, channel_id")
    .single();
  if (createError) {
    if (isMissingChatSchemaError(createError.message)) {
      throw new Error(`chat schema missing: ${createError.message}`);
    }
    throw new Error(`chat session create failed: ${createError.message}`);
  }

  return {
    id: created.id as string,
    scope: created.scope as ChatScope,
    ownerUserId: (created.owner_user_id as string | null) ?? null,
    title: (created.title as string | null) ?? "chat",
    channelId: (created.channel_id as string | null) ?? null
  };
}

export async function listAccessibleChatChannels(args: {
  supabase: SupabaseClient;
  orgId: string;
  userId: string;
}) {
  const { supabase, orgId, userId } = args;
  const { data, error } = await supabase
    .from("chat_channel_members")
    .select("channel_id, role, chat_channels!inner(id, name, description, created_at)")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingChatSchemaError(error.message)) {
      throw new Error(`chat schema missing: ${error.message}`);
    }
    throw new Error(`chat channel list failed: ${error.message}`);
  }
  return (data ?? []).map((row) => ({
    channelId: row.channel_id as string,
    role: (row.role as string) ?? "member",
    channel: (row.chat_channels as { id: string; name: string; description: string | null; created_at: string }[] | null)?.[0] ?? null
  }));
}
