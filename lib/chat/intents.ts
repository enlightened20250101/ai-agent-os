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
      intentType: "bulk_decide_approvals";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; decision: "approved" | "rejected"; maxItems: number; reason: string | null };
    }
  | {
      intentType: "bulk_retry_failed_commands";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; maxItems: number; scope: "current" | "shared" | "personal" | "all" };
    }
  | {
      intentType: "bulk_retry_failed_workflows";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; maxItems: number };
    }
  | {
      intentType: "quick_top_action";
      confidence: number;
      requiresConfirmation: true;
      plan: {
        summary: string;
        action: "request_approval" | "approve" | "reject" | "accept_proposal";
        index: number;
        target: "approval" | "proposal" | "exception" | "auto";
      };
    }
  | {
      intentType: "execute_action";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; taskHint: string | null };
    }
  | {
      intentType: "run_planner";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; maxProposals: number };
    }
  | {
      intentType: "run_workflow";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; taskHint: string | null };
    }
  | {
      intentType: "update_case_status";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; caseHint: string | null; status: "open" | "blocked" | "closed" };
    }
  | {
      intentType: "update_case_owner_self";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; caseHint: string | null };
    }
  | {
      intentType: "update_case_due";
      confidence: number;
      requiresConfirmation: true;
      plan: { summary: string; caseHint: string | null; dueAt: string };
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

function extractDueAtFromText(text: string) {
  const isoDate = text.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoDate) {
    const yyyy = isoDate[1];
    const mm = isoDate[2]?.padStart(2, "0");
    const dd = isoDate[3]?.padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T23:59:00+09:00`;
  }
  if (/(明日|tomorrow)/i.test(text)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T23:59:00+09:00`;
  }
  if (/(今日|本日|today)/i.test(text)) {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T23:59:00+09:00`;
  }
  return null;
}

export function parseChatIntent(message: string): ParsedChatIntent {
  const text = normalizeText(message);
  const lower = text.toLowerCase();
  const taskIdMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  const taskIdHint = taskIdMatch ? taskIdMatch[0] : null;

  const requestedCountRaw = text.match(/(\d+)\s*件/)?.[1];
  const requestedCount = requestedCountRaw ? Number.parseInt(requestedCountRaw, 10) : Number.NaN;
  const parsedCount = Number.isNaN(requestedCount) ? null : Math.max(1, Math.min(10, requestedCount));

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
  const caseStatusLike = /(案件|case)/i.test(text) && /(変更|更新|にして|にする|set|ステータス)/i.test(text);
  if (caseStatusLike) {
    const mappedStatus = /(blocked|block|保留|停止|止め|ブロック)/i.test(text)
      ? "blocked"
      : /(closed|close|クローズ|完了|終了|閉じ)/i.test(text)
        ? "closed"
        : /(open|再開|オープン|対応中|進行)/i.test(text)
          ? "open"
          : null;
    if (mappedStatus) {
      const caseHint = quoted ?? taskIdHint;
      return {
        intentType: "update_case_status",
        confidence: 0.8,
        requiresConfirmation: true,
        plan: {
          summary: caseHint
            ? `案件「${caseHint}」を ${mappedStatus} に更新します。`
            : `最新の案件を ${mappedStatus} に更新します。`,
          caseHint,
          status: mappedStatus
        }
      };
    }
  }

  const caseOwnerLike = /(案件|case)/i.test(text) && /(担当|owner|アサイン|割当|割り当て)/i.test(text);
  if (caseOwnerLike && /(自分|me|myself)/i.test(text)) {
    const caseHint = quoted ?? taskIdHint;
    return {
      intentType: "update_case_owner_self",
      confidence: 0.8,
      requiresConfirmation: true,
      plan: {
        summary: caseHint ? `案件「${caseHint}」の担当者を自分に設定します。` : "最新の案件の担当者を自分に設定します。",
        caseHint
      }
    };
  }

  const caseDueLike = /(案件|case)/i.test(text) && /(期限|due|締切|〆切|deadline)/i.test(text);
  if (caseDueLike) {
    const dueAt = extractDueAtFromText(text);
    if (dueAt) {
      const caseHint = quoted ?? taskIdHint;
      return {
        intentType: "update_case_due",
        confidence: 0.8,
        requiresConfirmation: true,
        plan: {
          summary: caseHint ? `案件「${caseHint}」の期限を更新します。` : "最新の案件の期限を更新します。",
          caseHint,
          dueAt
        }
      };
    }
  }

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

  const bulkApproveLike =
    /(承認待ち|pending approval|approvals?)/i.test(text) && /(まとめて|一括|全部|まとめて承認|bulk)/i.test(text);
  const bulkRejectLike =
    /(承認待ち|pending approval|approvals?)/i.test(text) && /(まとめて却下|一括却下|まとめて否認|bulk reject)/i.test(text);
  if (bulkApproveLike || bulkRejectLike) {
    const decision = bulkRejectLike ? "rejected" : "approved";
    const includesAll = /(全部|all)/i.test(text);
    const maxItems = includesAll ? 10 : (parsedCount ?? 3);
    return {
      intentType: "bulk_decide_approvals",
      confidence: 0.76,
      requiresConfirmation: true,
      plan: {
        summary: `承認待ちを最大${maxItems}件、${decision === "approved" ? "承認" : "却下"}します。`,
        decision,
        maxItems,
        reason: extractReason(text)
      }
    };
  }

  const bulkRetryLike =
    /(失敗コマンド|failed command|失敗したコマンド)/i.test(text) &&
    /(再実行確認|再実行|まとめて|一括|bulk retry)/i.test(text);
  if (bulkRetryLike) {
    const scope = /(shared|共有)/i.test(text)
      ? "shared"
      : /(personal|個人)/i.test(text)
        ? "personal"
        : /(all|全部|全体)/i.test(text)
          ? "all"
          : "current";
    const maxItems = parsedCount ?? 5;
    return {
      intentType: "bulk_retry_failed_commands",
      confidence: 0.77,
      requiresConfirmation: true,
      plan: {
        summary:
          scope === "current"
            ? `このチャットの失敗コマンドから最大${maxItems}件、再実行確認を作成します。`
            : `${scope} scope の失敗コマンドから最大${maxItems}件、再実行確認を作成します。`,
        maxItems,
        scope
      }
    };
  }

  const bulkWorkflowRetryLike =
    /(失敗ワークフロー|failed workflow|workflow run)/i.test(text) &&
    /(再試行|再実行|まとめて|一括|bulk retry)/i.test(text);
  if (bulkWorkflowRetryLike) {
    const maxItems = parsedCount ?? 3;
    return {
      intentType: "bulk_retry_failed_workflows",
      confidence: 0.78,
      requiresConfirmation: true,
      plan: {
        summary: `失敗workflow runを最大${maxItems}件再試行します。`,
        maxItems
      }
    };
  }

  const quickIndexMatch = text.match(/(?:#|No\.?|番号)?\s*([1-3])(?:番)?/i);
  const quickIndex = quickIndexMatch ? Number.parseInt(quickIndexMatch[1] ?? "0", 10) : Number.NaN;
  if (!Number.isNaN(quickIndex) && quickIndex >= 1 && quickIndex <= 3) {
    const action =
      /(承認依頼|approval request)/i.test(text)
        ? "request_approval"
        : /(受け入れ|採択|accept proposal)/i.test(text)
          ? "accept_proposal"
          : /(却下|reject|否認|差し戻し)/i.test(text)
            ? "reject"
            : /(承認|approve)/i.test(text)
              ? "approve"
              : null;
    if (action) {
      const target =
        /(提案|proposal)/i.test(text)
          ? "proposal"
          : /(例外|exception|失敗)/i.test(text)
            ? "exception"
            : /(承認|approval)/i.test(text)
              ? "approval"
              : "auto";
      return {
        intentType: "quick_top_action",
        confidence: 0.78,
        requiresConfirmation: true,
        plan: {
          summary: `TOP候補 #${quickIndex} に対して ${
            action === "request_approval"
              ? "承認依頼を作成"
              : action === "accept_proposal"
                ? "提案を受け入れ"
                : action === "approve"
                  ? "承認"
                  : "却下"
          } します。`,
          action,
          index: quickIndex,
          target
        }
      };
    }
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

  const plannerLike = /(プランナー|planner)/i.test(text) && /(実行|走らせ|run|回して|起動)/i.test(text);
  if (plannerLike) {
    const maxProposals = parsedCount ?? 2;
    return {
      intentType: "run_planner",
      confidence: 0.8,
      requiresConfirmation: true,
      plan: {
        summary: `プランナーを実行して提案を最大${maxProposals}件生成します。`,
        maxProposals
      }
    };
  }

  const workflowLike =
    /(ワークフロー|workflow)/i.test(text) &&
    /(実行|開始|start|run|進め|起動)/i.test(text);
  if (workflowLike) {
    return {
      intentType: "run_workflow",
      confidence: 0.8,
      requiresConfirmation: true,
      plan: {
        summary: quoted
          ? `タスク「${quoted}」のワークフロー実行を開始します。`
          : taskIdHint
            ? `タスクID ${taskIdHint} のワークフロー実行を開始します。`
            : "最新の対象タスクでワークフロー実行を開始します。",
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
        "要望を理解できませんでした。次の形式で指示してください。\n" +
        "1) タスク追加: 「請求フォロー」タスクを追加して\n" +
        "2) 承認依頼: 「E2E Task」を承認依頼して\n" +
        "3) 承認処理: 承認待ちを3件まとめて承認して\n" +
        "4) 実行: 「E2E Task」を実行して\n" +
        "5) 案件更新: 「請求書A」をblockedにして / 「請求書A」を自分に割り当てて / 「請求書A」の期限を2026-03-10にして\n" +
        "6) 自律系: プランナーを実行して / 失敗ワークフローを3件再試行して"
    }
  };
}
