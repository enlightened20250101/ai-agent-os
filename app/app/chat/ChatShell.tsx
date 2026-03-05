import { confirmChatCommand } from "@/app/app/chat/actions";
import type { ChatScope } from "@/lib/chat/sessions";
import { getOrCreateChatSession } from "@/lib/chat/sessions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

type ChatShellProps = {
  scope: ChatScope;
  title: string;
  description: string;
  // eslint-disable-next-line no-unused-vars
  submitAction: (...args: [FormData]) => Promise<void>;
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

type ChatMessageRow = {
  id: string;
  sender_type: string;
  body_text: string;
  created_at: string;
};

type ConfirmationRow = {
  id: string;
  intent_id: string;
  expires_at: string;
};

function speakerLabel(senderType: string) {
  if (senderType === "user") return "You";
  if (senderType === "system") return "Agent";
  return "Agent";
}

export async function ChatShell({ scope, title, description, submitAction, searchParams }: ChatShellProps) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const session = await getOrCreateChatSession({ supabase, orgId, scope, userId });

  const [{ data: messagesData, error: messagesError }, { data: confirmationsData, error: confirmationsError }] =
    await Promise.all([
      supabase
        .from("chat_messages")
        .select("id, sender_type, body_text, created_at")
        .eq("org_id", orgId)
        .eq("session_id", session.id)
        .order("created_at", { ascending: true })
        .limit(120),
      supabase
        .from("chat_confirmations")
        .select("id, intent_id, expires_at")
        .eq("org_id", orgId)
        .eq("session_id", session.id)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(20)
    ]);

  if (messagesError) {
    throw new Error(`Failed to load chat messages: ${messagesError.message}`);
  }
  if (confirmationsError) {
    throw new Error(`Failed to load chat confirmations: ${confirmationsError.message}`);
  }

  const confirmations = ((confirmationsData ?? []) as ConfirmationRow[]).filter((row) => {
    const expiresAt = new Date(row.expires_at).getTime();
    return Number.isFinite(expiresAt) ? expiresAt > Date.now() : false;
  });

  const intentIds = confirmations.map((row) => row.intent_id);
  let intentMap = new Map<string, string>();
  if (intentIds.length > 0) {
    const { data: intentsData, error: intentsError } = await supabase
      .from("chat_intents")
      .select("id, intent_json")
      .eq("org_id", orgId)
      .in("id", intentIds);
    if (intentsError) {
      throw new Error(`Failed to load chat intents: ${intentsError.message}`);
    }
    intentMap = new Map(
      (intentsData ?? []).map((row) => {
        const intentJson = typeof row.intent_json === "object" && row.intent_json !== null ? row.intent_json : {};
        const summary = typeof intentJson.summary === "string" ? intentJson.summary : "実行確認";
        return [row.id as string, summary];
      })
    );
  }

  const messages = (messagesData ?? []) as ChatMessageRow[];

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-600">{description}</p>
      </header>

      {sp.error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p>
      ) : null}
      {sp.ok ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{sp.ok}</p>
      ) : null}

      {confirmations.length > 0 ? (
        <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">実行確認待ち</p>
          {confirmations.map((confirmation) => (
            <div key={confirmation.id} className="rounded-md border border-amber-300 bg-white p-3">
              <p className="text-sm text-slate-800">{intentMap.get(confirmation.intent_id) ?? "実行確認"}</p>
              <p className="mt-1 text-xs text-slate-500">
                期限: {new Date(confirmation.expires_at).toLocaleString()}
              </p>
              <div className="mt-3 flex gap-2">
                <form action={confirmChatCommand}>
                  <input type="hidden" name="confirmation_id" value={confirmation.id} />
                  <input type="hidden" name="scope" value={scope} />
                  <button
                    type="submit"
                    name="decision"
                    value="confirmed"
                    className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs text-white hover:bg-emerald-600"
                  >
                    Yes 実行する
                  </button>
                </form>
                <form action={confirmChatCommand}>
                  <input type="hidden" name="confirmation_id" value={confirmation.id} />
                  <input type="hidden" name="scope" value={scope} />
                  <button
                    type="submit"
                    name="decision"
                    value="declined"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    No キャンセル
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <form action={submitAction} className="space-y-3">
          <label className="block text-sm font-medium text-slate-900" htmlFor="chat-input">
            メッセージ
          </label>
          <textarea
            id="chat-input"
            name="body"
            rows={3}
            required
            placeholder="例: 「請求書確認タスクを追加して」 / 「承認依頼を出して」 / 「〇〇を承認して」"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-0 placeholder:text-slate-400 focus:border-slate-400"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              タスク作成系は必ず確認ステップを挟んで実行されます。
            </p>
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800">
              送信
            </button>
          </div>
        </form>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-800">会話ログ</h2>
        {messages.length > 0 ? (
          <ul className="space-y-2">
            {messages.map((message) => {
              const isUser = message.sender_type === "user";
              return (
                <li
                  key={message.id}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    isUser ? "border-sky-200 bg-sky-50" : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span>{speakerLabel(message.sender_type)}</span>
                    <span>{new Date(message.created_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-slate-800">{message.body_text}</p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">まだメッセージはありません。</p>
        )}
      </div>
    </section>
  );
}
