export type MonitorSignalCounts = {
  stale_tasks: number;
  stale_pending_approvals: number;
  recent_action_failures: number;
  stale_open_cases: number;
  policy_warn_block_24h: number;
  new_inbound_events_24h: number;
};

export type MonitorRecoverySummary = {
  reminderSent: number;
  reminderTarget: number;
  workflowSuccess: number;
  workflowFailed: number;
  workflowTarget: number;
  workflowRecoveredExtra: number;
  workflowFailedRetryable: number;
  workflowFailedManual: number;
  caseAssigned: number;
  caseTarget: number;
  exceptionCasesCreated: number;
  exceptionCasesUpdated: number;
};

export type MonitorNextAction = {
  key: string;
  level: "high" | "medium" | "low";
  text: string;
  href: string;
  cta: string;
  evidence: string[];
  chatHint: string;
};

export type MonitorManualWorkflowFailure = {
  workflowRunId: string;
  reasonClass: "retryable" | "manual" | "unknown";
  reasonSummary: string;
};

function asObject(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseMonitorSignalCounts(value: unknown): MonitorSignalCounts {
  const row = asObject(value) ?? {};
  const toCount = (key: keyof MonitorSignalCounts) => {
    const raw = row[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };
  return {
    stale_tasks: toCount("stale_tasks"),
    stale_pending_approvals: toCount("stale_pending_approvals"),
    recent_action_failures: toCount("recent_action_failures"),
    stale_open_cases: toCount("stale_open_cases"),
    policy_warn_block_24h: toCount("policy_warn_block_24h"),
    new_inbound_events_24h: toCount("new_inbound_events_24h")
  };
}

export function parseMonitorRecoverySummary(value: unknown): MonitorRecoverySummary {
  const meta = asObject(value);
  const result = asObject(meta?.result);
  const reminder = asObject(result?.reminder);
  const workflowRetry = asObject(result?.workflow_retry);
  const failedDetails = Array.isArray(workflowRetry?.failed_details)
    ? workflowRetry?.failed_details
    : [];
  let workflowFailedRetryable = 0;
  let workflowFailedManual = 0;
  for (const row of failedDetails) {
    const detail = asObject(row);
    if (!detail) continue;
    if (detail.reason_class === "retryable") {
      workflowFailedRetryable += 1;
    } else if (detail.reason_class === "manual") {
      workflowFailedManual += 1;
    }
  }
  const caseAssignment = asObject(result?.case_assignment);
  const exceptionCases = asObject(result?.exception_cases);
  return {
    reminderSent: toNumber(reminder?.sentCount) ?? 0,
    reminderTarget: toNumber(reminder?.targetCount) ?? 0,
    workflowSuccess: toNumber(workflowRetry?.success) ?? 0,
    workflowFailed: toNumber(workflowRetry?.failed) ?? 0,
    workflowTarget: toNumber(workflowRetry?.target_count) ?? 0,
    workflowRecoveredExtra: toNumber(workflowRetry?.recovered_on_extra_pass) ?? 0,
    workflowFailedRetryable,
    workflowFailedManual,
    caseAssigned: toNumber(caseAssignment?.assigned) ?? 0,
    caseTarget: toNumber(caseAssignment?.target_count) ?? 0,
    exceptionCasesCreated: toNumber(exceptionCases?.created) ?? 0,
    exceptionCasesUpdated: toNumber(exceptionCases?.updated) ?? 0
  };
}

export function parseMonitorManualWorkflowFailures(value: unknown): MonitorManualWorkflowFailure[] {
  const meta = asObject(value);
  const result = asObject(meta?.result);
  const workflowRetry = asObject(result?.workflow_retry);
  const failedDetails = Array.isArray(workflowRetry?.failed_details)
    ? workflowRetry?.failed_details
    : [];
  const items: MonitorManualWorkflowFailure[] = [];
  for (const row of failedDetails) {
    const detail = asObject(row);
    if (!detail) continue;
    const workflowRunId =
      typeof detail.workflow_run_id === "string" && detail.workflow_run_id.length > 0
        ? detail.workflow_run_id
        : null;
    if (!workflowRunId) continue;
    const reasonClassRaw = typeof detail.reason_class === "string" ? detail.reason_class : "unknown";
    const reasonClass =
      reasonClassRaw === "retryable" || reasonClassRaw === "manual"
        ? reasonClassRaw
        : "unknown";
    const reasonSummary =
      typeof detail.reason_summary === "string" && detail.reason_summary.length > 0
        ? detail.reason_summary
        : "詳細理由なし";
    items.push({
      workflowRunId,
      reasonClass,
      reasonSummary
    });
  }
  return items;
}

export function buildMonitorNextActions(args: {
  signalCounts: MonitorSignalCounts;
  recoverySummary: MonitorRecoverySummary | null;
}) {
  const signal = args.signalCounts;
  const recovery = args.recoverySummary;
  const tips: MonitorNextAction[] = [];

  if ((recovery?.workflowFailedManual ?? 0) > 0 || signal.recent_action_failures > 0) {
    tips.push({
      key: "workflow_failures",
      level: "high",
      text: "workflow再試行で手動対応が必要な失敗が残っています。失敗runの詳細エラー確認を優先してください。",
      href: "/app/workflows/runs",
      cta: "失敗runを確認",
      evidence: [
        `workflow_retry_failed_manual=${recovery?.workflowFailedManual ?? 0}`,
        `workflow_retry_failed_retryable=${recovery?.workflowFailedRetryable ?? 0}`,
        `recent_action_failures=${signal.recent_action_failures}`
      ],
      chatHint: "workflow失敗が多いため /app/workflows/runs を優先確認"
    });
  } else if ((recovery?.workflowFailedRetryable ?? 0) > 0) {
    tips.push({
      key: "workflow_retryable_failures",
      level: "medium",
      text: "workflow再試行で一時失敗が残っています。時間を空けて再実行すると回収できる可能性があります。",
      href: "/app/workflows/runs",
      cta: "再試行対象を確認",
      evidence: [`workflow_retry_failed_retryable=${recovery?.workflowFailedRetryable ?? 0}`],
      chatHint: "workflowの一時失敗が残っているため /app/workflows/runs で再試行"
    });
  }

  if ((recovery?.reminderTarget ?? 0) > 0 && (recovery?.reminderSent ?? 0) === 0) {
    tips.push({
      key: "reminder_not_sent",
      level: "high",
      text: "承認催促の送信件数が0です。Slack連携設定またはクールダウン条件を確認してください。",
      href: "/app/approvals",
      cta: "承認キューを確認",
      evidence: [
        `reminder_sent=${recovery?.reminderSent ?? 0}`,
        `reminder_target=${recovery?.reminderTarget ?? 0}`,
        `stale_approvals=${signal.stale_pending_approvals}`
      ],
      chatHint: "承認催促の送信件数が0のため /app/approvals で設定と滞留を確認"
    });
  } else if (signal.stale_pending_approvals > 0) {
    tips.push({
      key: "stale_approvals",
      level: "medium",
      text: "承認待ち滞留があります。承認判断または催促を実行して滞留を解消してください。",
      href: "/app/approvals?stale_only=1",
      cta: "滞留承認を確認",
      evidence: [`stale_approvals=${signal.stale_pending_approvals}`],
      chatHint: "承認滞留があるため /app/approvals?stale_only=1 で解消"
    });
  }

  if (signal.stale_open_cases > 0 && (recovery?.caseAssigned ?? 0) === 0) {
    tips.push({
      key: "stale_case_unassigned",
      level: "medium",
      text: "未割当の滞留案件が残っています。担当割当または期限更新で回収担当を明確化してください。",
      href: "/app/cases",
      cta: "滞留案件を確認",
      evidence: [
        `stale_cases=${signal.stale_open_cases}`,
        `assigned_cases=${recovery?.caseAssigned ?? 0}`
      ],
      chatHint: "滞留案件があるため /app/cases で担当割当を実施"
    });
  }

  if (signal.policy_warn_block_24h > 0) {
    tips.push({
      key: "policy_warn_block",
      level: "low",
      text: "ポリシー warn/block が発生しています。実行前にドラフト内容と許可ドメインを再確認してください。",
      href: "/app/operations/exceptions",
      cta: "例外キューを確認",
      evidence: [`policy_warn_block=${signal.policy_warn_block_24h}`],
      chatHint: "policy warn/block があるため /app/operations/exceptions を確認"
    });
  }

  if (signal.new_inbound_events_24h > 0) {
    tips.push({
      key: "inbound_events_backlog",
      level: signal.new_inbound_events_24h >= 20 ? "high" : "medium",
      text: "外部イベントが未処理で滞留しています。イベント台帳で一次仕分けし、必要な提案/起票へつなげてください。",
      href: "/app/events?status=new",
      cta: "外部イベントを確認",
      evidence: [`new_inbound_events_24h=${signal.new_inbound_events_24h}`],
      chatHint: "外部イベント未処理が多いため /app/events?status=new で一次仕分け"
    });
  }

  return tips.slice(0, 4);
}
