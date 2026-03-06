export type CaseStage =
  | "intake"
  | "drafting"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "exception"
  | "blocked"
  | "completed";

type DeriveCaseStageArgs = {
  caseStatus: "open" | "blocked" | "closed";
  taskStatuses: string[];
};

export function deriveCaseStage(args: DeriveCaseStageArgs): CaseStage {
  const { caseStatus, taskStatuses } = args;
  const statuses = new Set(taskStatuses);

  if (caseStatus === "closed") return "completed";
  if (caseStatus === "blocked") return "blocked";
  if (statuses.size === 0) return "intake";
  if (statuses.has("failed")) return "exception";
  if (statuses.has("executing")) return "executing";
  if (statuses.has("approved")) return "approved";
  if (statuses.has("ready_for_approval")) return "awaiting_approval";
  if (statuses.has("done") && statuses.size === 1) return "completed";
  if (statuses.has("draft")) return "drafting";
  return "drafting";
}

export function summarizeTaskStatuses(taskStatuses: string[]) {
  const counts = new Map<string, number>();
  for (const status of taskStatuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return Object.fromEntries(Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0])));
}
