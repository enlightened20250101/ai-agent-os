export function inferCaseTypeFromExternalEvent(args: {
  provider: string;
  eventType: string;
  summary: string;
}) {
  const merged = `${args.eventType} ${args.summary}`.toLowerCase();
  if (merged.includes("invoice") || merged.includes("payment") || merged.includes("purchase")) return "finance_ops";
  if (merged.includes("approval")) return "approval_ops";
  if (merged.includes("incident") || merged.includes("security") || merged.includes("error") || merged.includes("failed")) {
    return "incident_ops";
  }
  if (args.provider.toLowerCase() === "slack") return "chat_ops";
  return "general";
}

export function buildCaseTitleFromExternalEvent(args: {
  provider: string;
  eventType: string;
  summary: string;
}) {
  const base = args.summary.trim().length > 0 ? args.summary.trim().slice(0, 120) : `${args.provider}:${args.eventType}`;
  return `外部イベント対応: ${base}`;
}
