export type ParsedChatIntent =
  | {
      intentType: "status_query";
      confidence: number;
      requiresConfirmation: false;
      plan: { summary: string };
    }
  | {
      intentType: "create_task";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; title: string; inputText: string };
    }
  | {
      intentType: "unknown";
      confidence: number;
      requiresConfirmation: false;
      plan: { summary: string };
    };

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function extractQuoted(text: string) {
  const m = text.match(/[「"]([^"」]+)[」"]/);
  if (!m) return null;
  return normalizeText(m[1] ?? "");
}

export function parseChatIntent(message: string): ParsedChatIntent {
  const text = normalizeText(message);
  const lower = text.toLowerCase();

  const statusKeywords = ["どうなってる", "状況", "ステータス", "進捗", "status"];
  if (statusKeywords.some((kw) => lower.includes(kw))) {
    return {
      intentType: "status_query",
      confidence: 0.85,
      requiresConfirmation: false,
      plan: {
        summary: "現在のタスク/承認/実行状況を要約して返答します。"
      }
    };
  }

  const createTaskLike =
    (/タスク/.test(text) && /(追加|作成|登録|入れて|起票)/.test(text)) ||
    /^add task/i.test(text) ||
    /create task/i.test(lower);

  if (createTaskLike) {
    const extracted = extractQuoted(text);
    const title = extracted || normalizeText(text.replace(/(タスク|を|追加|作成|登録|して|お願いします|お願い|ください|。)/g, "")).slice(0, 80) || "チャット起点タスク";
    return {
      intentType: "create_task",
      confidence: 0.8,
      requiresConfirmation: true,
      plan: {
        summary: `タスク「${title}」を作成します。`,
        title,
        inputText: message
      }
    };
  }

  return {
    intentType: "unknown",
    confidence: 0.4,
    requiresConfirmation: false,
    plan: {
      summary: "要望を理解できませんでした。タスク追加や状況確認として具体的に指示してください。"
    }
  };
}
