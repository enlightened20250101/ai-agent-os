type ExternalEventLike = {
  provider: string | null;
  eventType: string | null;
  summaryText: string | null;
  createdAt: string | null;
};

export type ExternalEventPriority = "low" | "normal" | "high" | "urgent";

export type ExternalEventTriageResult = {
  priority: ExternalEventPriority;
  triageNote: string;
};

function ageHours(createdAt: string | null) {
  if (!createdAt) return 0;
  const ms = new Date(createdAt).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, (Date.now() - ms) / (1000 * 60 * 60));
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function escalate(priority: ExternalEventPriority): ExternalEventPriority {
  if (priority === "low") return "normal";
  if (priority === "normal") return "high";
  if (priority === "high") return "urgent";
  return "urgent";
}

export function triageExternalEvent(input: ExternalEventLike): ExternalEventTriageResult {
  const provider = (input.provider ?? "").toLowerCase();
  const eventType = (input.eventType ?? "").toLowerCase();
  const summary = (input.summaryText ?? "").toLowerCase();
  const merged = `${eventType} ${summary}`;

  let priority: ExternalEventPriority = "normal";
  const reasons: string[] = [];

  if (includesAny(merged, ["incident", "breach", "unauthorized", "security", "fraud"])) {
    priority = "urgent";
    reasons.push("security_or_incident_signal");
  } else if (includesAny(merged, ["failed", "error", "overdue", "timeout", "bounce"])) {
    priority = "high";
    reasons.push("failure_or_overdue_signal");
  } else if (includesAny(merged, ["invoice", "payment", "approval", "contract", "purchase"])) {
    priority = "high";
    reasons.push("business_critical_signal");
  } else if (includesAny(merged, ["info", "heartbeat", "healthcheck", "keepalive"])) {
    priority = "low";
    reasons.push("low_value_signal");
  }

  if (provider === "slack" && includesAny(merged, ["@ai", "mention", "approval"])) {
    priority = escalate(priority);
    reasons.push("slack_mention_or_approval");
  }

  if (provider === "gmail" && includesAny(merged, ["invoice", "payment due", "urgent"])) {
    priority = escalate(priority);
    reasons.push("gmail_finance_signal");
  }

  const hours = ageHours(input.createdAt);
  if (hours >= 24) {
    priority = escalate(priority);
    reasons.push("stale_24h");
  }

  return {
    priority,
    triageNote: reasons.length > 0 ? reasons.join(",") : "default_normal"
  };
}
