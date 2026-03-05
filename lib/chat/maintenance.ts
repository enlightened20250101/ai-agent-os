import type { SupabaseClient } from "@supabase/supabase-js";

export async function expirePendingChatConfirmations(args: {
  supabase: SupabaseClient;
  orgId: string;
  actorUserId: string | null;
  source: "manual" | "cron";
}) {
  const { supabase, orgId, actorUserId, source } = args;
  const nowIso = new Date().toISOString();

  const { data: expiredRows, error: updateError } = await supabase
    .from("chat_confirmations")
    .update({
      status: "expired",
      decided_at: nowIso,
      decided_by: actorUserId
    })
    .eq("org_id", orgId)
    .eq("status", "pending")
    .lt("expires_at", nowIso)
    .select("id, session_id, intent_id, expires_at");

  if (updateError) {
    throw new Error(`期限切れ更新に失敗しました: ${updateError.message}`);
  }

  const rows = expiredRows ?? [];
  if (rows.length > 0) {
    const messages = rows.map((row) => ({
      org_id: orgId,
      session_id: row.session_id as string,
      sender_type: "system",
      sender_user_id: null,
      body_text: "確認期限切れのため、この実行確認は無効化されました。",
      metadata_json: {
        confirmation_id: row.id,
        intent_id: row.intent_id,
        auto_expired: true,
        expired_at: nowIso,
        source
      }
    }));
    const { error: insertError } = await supabase.from("chat_messages").insert(messages);
    if (insertError) {
      throw new Error(`期限切れ通知の保存に失敗しました: ${insertError.message}`);
    }
  }

  return {
    expiredCount: rows.length
  };
}
