import type { SupabaseClient } from "@supabase/supabase-js";

export type ChatScope = "shared" | "personal";

export async function getOrCreateChatSession(args: {
  supabase: SupabaseClient;
  orgId: string;
  scope: ChatScope;
  userId: string;
}) {
  const { supabase, orgId, scope, userId } = args;
  let query = supabase
    .from("chat_sessions")
    .select("id, scope, owner_user_id, title")
    .eq("org_id", orgId)
    .eq("scope", scope)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (scope === "personal") {
    query = query.eq("owner_user_id", userId);
  }

  const { data: existing, error: lookupError } = await query.maybeSingle();
  if (lookupError) {
    throw new Error(`chat session lookup failed: ${lookupError.message}`);
  }
  if (existing?.id) {
    return {
      id: existing.id as string,
      scope: existing.scope as ChatScope,
      ownerUserId: (existing.owner_user_id as string | null) ?? null,
      title: (existing.title as string | null) ?? "chat"
    };
  }

  const { data: created, error: createError } = await supabase
    .from("chat_sessions")
    .insert({
      org_id: orgId,
      scope,
      owner_user_id: scope === "personal" ? userId : null,
      title: scope === "personal" ? "my-chat" : "shared-chat"
    })
    .select("id, scope, owner_user_id, title")
    .single();
  if (createError) {
    throw new Error(`chat session create failed: ${createError.message}`);
  }

  return {
    id: created.id as string,
    scope: created.scope as ChatScope,
    ownerUserId: (created.owner_user_id as string | null) ?? null,
    title: (created.title as string | null) ?? "chat"
  };
}
