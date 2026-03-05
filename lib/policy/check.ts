import type { DraftOutput } from "@/lib/llm/openai";

export type PolicyStatus = "pass" | "warn" | "block";

export type PolicyResult = {
  status: PolicyStatus;
  reasons: string[];
};

type PolicyInput = {
  draft: DraftOutput;
};

const PHONE_REGEX = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?){2,4}\d{2,4}\b/;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/;

function getAllowedDomains() {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function extractDomain(email: string) {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  return email.slice(at + 1).toLowerCase();
}

export function checkDraftPolicy(input: PolicyInput): {
  result: PolicyResult;
  evaluatedAction: DraftOutput["proposed_actions"][number] | null;
} {
  const action = input.draft.proposed_actions[0] ?? null;
  const reasons: string[] = [];
  let status: PolicyStatus = "pass";

  if (!action) {
    return {
      result: {
        status: "block",
        reasons: ["モデル出力に提案アクションがありません。"]
      },
      evaluatedAction: null
    };
  }

  const allowedDomains = getAllowedDomains();
  const toDomain = extractDomain(action.to);
  if (allowedDomains.length > 0) {
    if (!toDomain || !allowedDomains.includes(toDomain)) {
      status = "block";
      reasons.push(
        `宛先ドメイン ${toDomain ?? "(無効)"} は ALLOWED_EMAIL_DOMAINS に含まれていません。`
      );
    }
  } else {
    reasons.push("ALLOWED_EMAIL_DOMAINS が未設定のため、宛先ドメインチェックは参考情報です。");
  }

  if (PHONE_REGEX.test(action.body_text)) {
    if (status !== "block") {
      status = "warn";
    }
    reasons.push("本文に電話番号らしき内容が含まれています。");
  }

  if (CREDIT_CARD_REGEX.test(action.body_text)) {
    if (status !== "block") {
      status = "warn";
    }
    reasons.push("本文にクレジットカード番号らしき数値列が含まれています。");
  }

  return {
    result: {
      status,
      reasons
    },
    evaluatedAction: action
  };
}
