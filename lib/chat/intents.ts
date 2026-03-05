export type ParsedChatIntent =
  | {
      intentType: "status_query";
      confidence: number;
      requiresConfirmation: false;
      plan: { summary: string; taskHint: string | null };
    }
  | {
      intentType: "create_task";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; title: string; inputText: string };
    }
  | {
      intentType: "request_approval";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; taskHint: string | null };
    }
  | {
      intentType: "decide_approval";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; decision: "approved" | "rejected"; taskHint: string | null; reason: string | null };
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

function extractReason(text: string) {
  const m = text.match(/理由[:：]\s*([^。\n]+)/);
  if (!m) return null;
  const reason = normalizeText(m[1] ?? "");
  return reason.length > 0 ? reason.slice(0, 180) : null;
}

export function parseChatIntent(message: string): ParsedChatIntent {
  const text = normalizeText(message);
  const lower = text.toLowerCase();

  const statusKeywords = ["どうなってる", "状況", "ステータス", "進捗", "status"];
  if (statusKeywords.some((kw) => lower.includes(kw))) {
    const taskHint = extractQuoted(text);
    return {
      intentType: "status_query",
      confidence: 0.85,
      requiresConfirmation: false,
      plan: {
        summary: taskHint
          ? `タスク「${taskHint}」の状況を確認します。`
          : "現在のタスク/承認/実行状況を要約して返答します。",
        taskHint
      }
    };
  }

  const quoted = extractQuoted(text);

  const requestApprovalLike =
    /(承認依頼|承認を依頼|承認リクエスト|request approval)/i.test(text) ||
    (/承認/.test(text) && /(依頼|出して|送って|申請)/.test(text));
  if (requestApprovalLike) {
    return {
      intentType: "request_approval",
      confidence: 0.8,
      requiresConfirmation: true,
      plan: {
        summary: quoted
          ? `タスク「${quoted}」の承認依頼を作成します。`
          : "最新の対象タスクで承認依頼を作成します。",
        taskHint: quoted
      }
    };
  }

  const approveLike = /(承認して|approve|okで承認|承認お願いします)/i.test(text);
  const rejectLike = /(却下して|reject|差し戻し|否認)/i.test(text);
  if (approveLike || rejectLike) {
    const decision = rejectLike ? "rejected" : "approved";
    return {
      intentType: "decide_approval",
      confidence: 0.78,
      requiresConfirmation: true,
      plan: {
        summary: quoted
          ? `タスク「${quoted}」の承認を${decision === "approved" ? "承認" : "却下"}します。`
          : `最新の承認待ちを${decision === "approved" ? "承認" : "却下"}します。`,
        decision,
        taskHint: quoted,
        reason: extractReason(text)
      }
    };
  }

  const createTaskLike =
    (/タスク/.test(text) && /(追加|作成|登録|入れて|起票)/.test(text)) ||
    /^add task/i.test(text) ||
    /create task/i.test(lower);

  if (createTaskLike) {
    const title =
      quoted ||
      normalizeText(text.replace(/(タスク|を|追加|作成|登録|して|お願いします|お願い|ください|。)/g, "")).slice(0, 80) ||
      "チャット起点タスク";
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
      summary: "要望を理解できませんでした。タスク追加、承認依頼、承認/却下、状況確認として具体的に指示してください。"
    }
  };
}
