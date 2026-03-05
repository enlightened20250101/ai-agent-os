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
        reasons: ["No proposed action found in model output."]
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
        `Recipient domain ${toDomain ?? "(invalid)"} is not in ALLOWED_EMAIL_DOMAINS.`
      );
    }
  } else {
    reasons.push("ALLOWED_EMAIL_DOMAINS is not set; recipient domain check is informational only.");
  }

  if (PHONE_REGEX.test(action.body_text)) {
    if (status !== "block") {
      status = "warn";
    }
    reasons.push("Body text appears to contain phone-like content.");
  }

  if (CREDIT_CARD_REGEX.test(action.body_text)) {
    if (status !== "block") {
      status = "warn";
    }
    reasons.push("Body text appears to contain credit-card-like numeric content.");
  }

  return {
    result: {
      status,
      reasons
    },
    evaluatedAction: action
  };
}
