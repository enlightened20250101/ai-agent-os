export type ParsedChatIntent =
  | {
      intentType: "status_query";
      confidence: number;
      requiresConfirmation: false;
      plan: { summary: string; taskHint: string | null; focus: "overview" | "approval" | "proposal" | "exception" | "incident" };
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
      intentType: "accept_proposal";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; proposalHint: string | null; autoRequestApproval: boolean };
    }
  | {
      intentType: "decide_approval";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; decision: "approved" | "rejected"; taskHint: string | null; reason: string | null };
    }
  | {
      intentType: "execute_action";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; taskHint: string | null };
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
  const taskIdMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  const taskIdHint = taskIdMatch ? taskIdMatch[0] : null;

  const statusKeywords = ["どうなってる", "状況", "ステータス", "進捗", "status"];
  if (statusKeywords.some((kw) => lower.includes(kw))) {
    const taskHint = extractQuoted(text) ?? taskIdHint;
    const focus = (() => {
      if (/(承認|approval)/i.test(text)) return "approval" as const;
      if (/(提案|proposal|プランナー)/i.test(text)) return "proposal" as const;
      if (/(例外|失敗|エラー|exception)/i.test(text)) return "exception" as const;
      if (/(インシデント|incident|障害)/i.test(text)) return "incident" as const;
      return "overview" as const;
    })();
    return {
      intentType: "status_query",
      confidence: 0.85,
      requiresConfirmation: false,
      plan: {
        summary: taskHint
          ? `タスク「${taskHint}」の状況を確認します。`
          : focus === "approval"
            ? "承認キューの状況を要約して返答します。"
            : focus === "proposal"
              ? "提案キューの状況を要約して返答します。"
              : focus === "exception"
                ? "例外キューの状況を要約して返答します。"
                : focus === "incident"
                  ? "インシデント状況を要約して返答します。"
                  : "現在のタスク/承認/実行状況を要約して返答します。",
        taskHint,
        focus
      }
    };
  }

  const quoted = extractQuoted(text);
  const explicitTaskHint = quoted ?? taskIdHint;

  const acceptProposalLike =
    /(提案.*(受け入れ|採用)|受け入れ.*提案|accept proposal|提案を.*承認依頼|提案を.*タスク化)/i.test(text) ||
    (/提案/.test(text) && /(受け入れて|採択|取り込んで)/.test(text));
  if (acceptProposalLike) {
    const autoRequestApproval = /(承認依頼|承認まで|approval)/i.test(text);
    return {
      intentType: "accept_proposal",
      confidence: 0.81,
      requiresConfirmation: true,
      plan: {
        summary: quoted
          ? `提案「${quoted}」を受け入れてタスク化${autoRequestApproval ? "し、承認依頼まで作成" : ""}します。`
          : taskIdHint
            ? `提案ID ${taskIdHint} を受け入れてタスク化${autoRequestApproval ? "し、承認依頼まで作成" : ""}します。`
            : `最優先の提案を受け入れてタスク化${autoRequestApproval ? "し、承認依頼まで作成" : ""}します。`,
        proposalHint: quoted ?? taskIdHint,
        autoRequestApproval
      }
    };
  }

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
          : taskIdHint
            ? `タスクID ${taskIdHint} の承認依頼を作成します。`
          : "最新の対象タスクで承認依頼を作成します。",
        taskHint: explicitTaskHint
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
          : taskIdHint
            ? `タスクID ${taskIdHint} の承認を${decision === "approved" ? "承認" : "却下"}します。`
          : `最新の承認待ちを${decision === "approved" ? "承認" : "却下"}します。`,
        decision,
        taskHint: explicitTaskHint,
        reason: extractReason(text)
      }
    };
  }

  const executeLike =
    /(実行して|実行していい|メール送信して|メールを送って|execute|send email)/i.test(text) ||
    (/タスク/.test(text) && /(実行|送信)/.test(text));
  if (executeLike) {
    return {
      intentType: "execute_action",
      confidence: 0.79,
      requiresConfirmation: true,
      plan: {
        summary: quoted
          ? `タスク「${quoted}」のメール実行を開始します。`
          : taskIdHint
            ? `タスクID ${taskIdHint} のメール実行を開始します。`
          : "最新の対象タスクでメール実行を開始します。",
        taskHint: explicitTaskHint
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
      summary:
        "要望を理解できませんでした。タスク追加、提案受け入れ、承認依頼、承認/却下、状況確認として具体的に指示してください。"
    }
  };
}
