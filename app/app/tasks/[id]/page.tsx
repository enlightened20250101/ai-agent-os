import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmSubmitButton } from "@/app/app/ConfirmSubmitButton";
import { StatusNotice } from "@/app/app/StatusNotice";
import {
  executeDraftAction,
  generateDraft,
  requestApproval,
  setTaskReadyForApproval
} from "@/app/app/tasks/[id]/actions";
import { startWorkflowRunFromTask } from "@/app/app/workflows/actions";
import { computeGoogleSendEmailIdempotencyKey } from "@/lib/actions/idempotency";
import { resolveGoogleRuntimeConfig } from "@/lib/connectors/runtime";
import { evaluateGovernance, type GovernanceEvaluation } from "@/lib/governance/evaluate";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TaskDetailsPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ error?: string; ok?: string }>;
};

type DraftView = {
  summary: string;
  proposed_actions: Array<{
    provider: string;
    action_type: string;
    to: string;
    subject: string;
    body_text: string;
  }>;
  risks: string[];
};

type PolicyView = {
  status: "pass" | "warn" | "block";
  reasons: string[];
};

type ActionRow = {
  id: string;
  idempotency_key: string;
  provider: string;
  action_type: string;
  status: string;
  created_at: string;
  result_json: unknown;
};

type TaskOrigin = {
  source: "manual" | "slack" | "proposal" | "system";
  proposalId: string | null;
};

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
  if (at <= 0 || at >= email.length - 1) {
    return null;
  }
  return email.slice(at + 1).toLowerCase();
}

function parseDraftPayload(payload: unknown): DraftView | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const container = payload as Record<string, unknown>;
  const output = container.output;
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const draft = output as Record<string, unknown>;
  if (typeof draft.summary !== "string") {
    return null;
  }
  if (!Array.isArray(draft.proposed_actions) || !Array.isArray(draft.risks)) {
    return null;
  }

  const actions = draft.proposed_actions
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return null;
      }
      const row = item as Record<string, unknown>;
      if (
        typeof row.provider !== "string" ||
        typeof row.action_type !== "string" ||
        typeof row.to !== "string" ||
        typeof row.subject !== "string" ||
        typeof row.body_text !== "string"
      ) {
        return null;
      }
      return {
        provider: row.provider,
        action_type: row.action_type,
        to: row.to,
        subject: row.subject,
        body_text: row.body_text
      };
    })
    .filter((value): value is DraftView["proposed_actions"][number] => value !== null);

  const risks = draft.risks.filter((item): item is string => typeof item === "string");
  return {
    summary: draft.summary,
    proposed_actions: actions,
    risks
  };
}

function parsePolicyPayload(payload: unknown): PolicyView | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const data = payload as Record<string, unknown>;
  if (data.status !== "pass" && data.status !== "warn" && data.status !== "block") {
    return null;
  }
  if (!Array.isArray(data.reasons)) {
    return null;
  }
  return {
    status: data.status,
    reasons: data.reasons.filter((item): item is string => typeof item === "string")
  };
}

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function parseTaskOrigin(events: Array<{ event_type: string; payload_json: unknown }>) {
  const hasSlackIntake = events.some((event) => event.event_type === "SLACK_TASK_INTAKE");
  const taskCreated = events.find((event) => event.event_type === "TASK_CREATED");
  let proposalId: string | null = null;
  let sourceRaw = "";
  if (taskCreated && typeof taskCreated.payload_json === "object" && taskCreated.payload_json !== null) {
    const payload = taskCreated.payload_json as Record<string, unknown>;
    proposalId = typeof payload.proposal_id === "string" ? payload.proposal_id : null;
    const changedFields =
      typeof payload.changed_fields === "object" && payload.changed_fields !== null
        ? (payload.changed_fields as Record<string, unknown>)
        : null;
    sourceRaw = typeof changedFields?.source === "string" ? changedFields.source : "";
  }

  if (hasSlackIntake || sourceRaw.includes("slack")) {
    return { source: "slack", proposalId } as TaskOrigin;
  }
  if (proposalId || sourceRaw.includes("proposal")) {
    return { source: "proposal", proposalId } as TaskOrigin;
  }
  if (sourceRaw.includes("system")) {
    return { source: "system", proposalId } as TaskOrigin;
  }
  return { source: "manual", proposalId } as TaskOrigin;
}

function sourceBadgeClass(source: TaskOrigin["source"]) {
  if (source === "slack") return "border-sky-300 bg-sky-50 text-sky-700";
  if (source === "proposal") return "border-violet-300 bg-violet-50 text-violet-700";
  if (source === "system") return "border-slate-300 bg-slate-100 text-slate-700";
  return "border-emerald-300 bg-emerald-50 text-emerald-700";
}

export default async function TaskDetailsPage({ params, searchParams }: TaskDetailsPageProps) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const [
    { data: task, error: taskError },
    { data: events, error: eventsError },
    { data: approvals, error: approvalsError },
    { data: actions, error: actionsError },
    templatesRes,
    workflowRunsRes
  ] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, title, input_text, status, created_at, agent_id")
        .eq("id", id)
        .eq("org_id", orgId)
        .maybeSingle(),
      supabase
        .from("task_events")
        .select("id, event_type, payload_json, actor_id, created_at")
        .eq("org_id", orgId)
        .eq("task_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("approvals")
        .select("id, status, reason, requested_by, approver_user_id, created_at, decided_at")
        .eq("org_id", orgId)
        .eq("task_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("actions")
        .select("id, idempotency_key, provider, action_type, status, created_at, result_json")
        .eq("org_id", orgId)
        .eq("task_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("workflow_templates")
        .select("id, name")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false }),
      supabase
        .from("workflow_runs")
        .select("id, status, current_step_key, started_at, finished_at, template_id")
        .eq("org_id", orgId)
        .eq("task_id", id)
        .order("created_at", { ascending: false })
    ]);

  if (taskError) {
    throw new Error(`Failed to load task: ${taskError.message}`);
  }
  if (eventsError) {
    throw new Error(`Failed to load task events: ${eventsError.message}`);
  }
  if (approvalsError) {
    throw new Error(`Failed to load approvals: ${approvalsError.message}`);
  }
  if (actionsError) {
    throw new Error(`Failed to load actions: ${actionsError.message}`);
  }

  if (!task) {
    notFound();
  }

  const templates =
    templatesRes.error && isMissingTableError(templatesRes.error.message, "workflow_templates")
      ? []
      : ((templatesRes.data ?? []) as Array<{ id: string; name: string }>);
  if (templatesRes.error && !isMissingTableError(templatesRes.error.message, "workflow_templates")) {
    throw new Error(`Failed to load workflow templates: ${templatesRes.error.message}`);
  }

  const workflowRuns =
    workflowRunsRes.error && isMissingTableError(workflowRunsRes.error.message, "workflow_runs")
      ? []
      : ((workflowRunsRes.data ?? []) as Array<{
          id: string;
          status: string;
          current_step_key: string | null;
          started_at: string;
          finished_at: string | null;
          template_id: string;
        }>);
  if (workflowRunsRes.error && !isMissingTableError(workflowRunsRes.error.message, "workflow_runs")) {
    throw new Error(`Failed to load workflow runs: ${workflowRunsRes.error.message}`);
  }
  const templateNameById = new Map(templates.map((template) => [template.id, template.name]));

  const latestModelEvent = [...(events ?? [])].reverse().find((event) => event.event_type === "MODEL_INFERRED");
  const latestPolicyEvent = [...(events ?? [])].reverse().find((event) => event.event_type === "POLICY_CHECKED");
  const taskOrigin = parseTaskOrigin(
    (events ?? []).map((event) => ({
      event_type: event.event_type as string,
      payload_json: event.payload_json
    }))
  );

  const latestDraft = parseDraftPayload(latestModelEvent?.payload_json);
  const latestPolicy = parsePolicyPayload(latestPolicyEvent?.payload_json);
  const canRequestApproval = Boolean(latestDraft && latestPolicy && latestPolicy.status !== "block");
  const proposedEmailAction =
    latestDraft?.proposed_actions.find(
      (action) => action.provider === "google" && action.action_type === "send_email"
    ) ?? null;
  const executeBaseReasons: string[] = [];
  const currentIdempotencyKey = proposedEmailAction
    ? computeGoogleSendEmailIdempotencyKey({
        taskId: id,
        provider: "google",
        actionType: "send_email",
        to: proposedEmailAction.to,
        subject: proposedEmailAction.subject,
        bodyText: proposedEmailAction.body_text
      })
    : null;

  if (!latestDraft || !proposedEmailAction) {
    executeBaseReasons.push("最新ドラフトに実行可能な google/send_email がありません。");
  }
  if (!latestPolicy) {
    executeBaseReasons.push("ポリシーチェック結果がありません。");
  } else if (latestPolicy.status === "block") {
    executeBaseReasons.push("ポリシーステータスが block です。");
  }

  const allowedDomains = getAllowedDomains();
  if (proposedEmailAction && allowedDomains.length > 0) {
    const domain = extractDomain(proposedEmailAction.to);
    if (!domain || !allowedDomains.includes(domain)) {
      executeBaseReasons.push(`宛先ドメイン ${domain ?? "(無効)"} は許可されていません。`);
    }
  }

  const googleCfg = await resolveGoogleRuntimeConfig({ supabase, orgId });
  const hasGoogleConnector =
    process.env.E2E_MODE === "1" ||
    (Boolean(googleCfg.clientId) &&
      Boolean(googleCfg.clientSecret) &&
      Boolean(googleCfg.refreshToken) &&
      Boolean(googleCfg.senderEmail));
  if (!hasGoogleConnector) {
    executeBaseReasons.push("Googleコネクタが未設定です（DB または env フォールバック）。");
  }

  const actionHistory = (actions ?? []) as ActionRow[];
  const runningAction = actionHistory.find((action) => action.status === "running") ?? null;
  const existingSuccessForDraft =
    currentIdempotencyKey
      ? actionHistory.find(
          (action) => action.idempotency_key === currentIdempotencyKey && action.status === "success"
        ) ?? null
      : null;

  let governanceEvaluation: GovernanceEvaluation | null = null;
  if (latestPolicy && proposedEmailAction) {
    let agentRoleKey: string | null = null;
    if (task.agent_id) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("role_key")
        .eq("id", task.agent_id as string)
        .eq("org_id", orgId)
        .maybeSingle();
      agentRoleKey = (agentRow?.role_key as string | undefined) ?? null;
    }

    governanceEvaluation = await evaluateGovernance({
      supabase,
      orgId,
      taskId: id,
      provider: "google",
      actionType: "send_email",
      to: proposedEmailAction.to,
      subject: proposedEmailAction.subject,
      bodyText: proposedEmailAction.body_text,
      policyStatus: latestPolicy.status,
      agentRoleKey,
      persistAssessment: false
    });
  }

  const executeFinalReasons = [...executeBaseReasons];
  if (governanceEvaluation) {
    if (governanceEvaluation.decision === "block") {
      executeFinalReasons.push(
        `ガバナンス判定が block です。${governanceEvaluation.reasons.join(" ")}`
      );
    } else if ((task.status as string) !== "approved" && governanceEvaluation.decision !== "allow_auto_execute") {
      executeFinalReasons.push("タスクステータスが approved ではありません。");
    }
  } else if ((task.status as string) !== "approved") {
    executeFinalReasons.push("タスクステータスが approved ではありません。");
  }

  const canExecuteEmailFinal = executeFinalReasons.length === 0;
  const latestAction = actionHistory[0] ?? null;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{task.title as string}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <p>ステータス: {task.status as string}</p>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${sourceBadgeClass(taskOrigin.source)}`}>
                source: {taskOrigin.source}
              </span>
              {taskOrigin.proposalId ? (
                <Link href={`/app/proposals`} className="text-[11px] underline">
                  proposal_id: {taskOrigin.proposalId.slice(0, 8)}...
                </Link>
              ) : null}
            </div>
          </div>
          <Link href="/app/tasks" className="text-sm">
            タスク一覧へ戻る
          </Link>
          <Link href={`/app/tasks/${task.id as string}/evidence`} className="text-sm">
            証跡パック
          </Link>
        </div>

        <StatusNotice ok={sp.ok} error={sp.error} className="mt-4" />

        <div className="mt-4 rounded-md bg-slate-50 p-4">
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{task.input_text as string}</p>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <form action={generateDraft}>
            <input type="hidden" name="task_id" value={task.id as string} />
            <ConfirmSubmitButton
              label="ドラフト生成"
              pendingLabel="生成中..."
              confirmMessage="このタスクのドラフト生成を実行します。よろしいですか？"
              className="rounded-md bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-600"
            />
          </form>
          <form action={setTaskReadyForApproval}>
            <input type="hidden" name="task_id" value={task.id as string} />
            <ConfirmSubmitButton
              label="承認待ちにする"
              pendingLabel="更新中..."
              confirmMessage="このタスクを ready_for_approval に更新します。よろしいですか？"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            />
          </form>
          {canRequestApproval ? (
            <form action={requestApproval}>
              <input type="hidden" name="task_id" value={task.id as string} />
              <ConfirmSubmitButton
                label="承認依頼"
                pendingLabel="依頼中..."
                confirmMessage="このタスクの承認依頼を作成します。よろしいですか？"
                className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800"
              />
            </form>
          ) : (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {latestDraft
                ? latestPolicy?.status === "block"
                  ? "ポリシーステータスが block のため承認依頼できません。"
                  : "ドラフト生成でポリシーチェックを実行してください。"
                : "承認依頼の前にドラフトを生成してください。"}
            </p>
          )}
          {canExecuteEmailFinal ? (
            <form action={executeDraftAction}>
              <input type="hidden" name="task_id" value={task.id as string} />
              <ConfirmSubmitButton
                label={
                  governanceEvaluation?.decision === "allow_auto_execute" && (task.status as string) !== "approved"
                    ? "自動承認してメール送信を実行"
                    : "メール送信を実行"
                }
                pendingLabel="実行中..."
                confirmMessage="メール送信アクションを実行します。よろしいですか？"
                className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600"
              />
            </form>
          ) : (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              メール送信を実行できません: {executeFinalReasons.join(" ")}
            </p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">ワークフロー</h2>
        {templates.length > 0 ? (
          <form action={startWorkflowRunFromTask} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="task_id" value={task.id as string} />
            <select
              name="template_id"
              required
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
              defaultValue=""
            >
              <option value="">テンプレートを選択</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            <ConfirmSubmitButton
              label="ワークフロー実行を開始"
              pendingLabel="開始中..."
              confirmMessage="選択したテンプレートでワークフロー実行を開始します。よろしいですか？"
              className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white"
            />
            <Link href="/app/workflows/runs" className="text-sm underline">
              実行一覧
            </Link>
          </form>
        ) : (
          <p className="mt-3 text-sm text-slate-600">
            ワークフローテンプレートがありません。`/app/workflows` で作成してください。
          </p>
        )}

        {workflowRuns.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {workflowRuns.map((run) => (
              <li key={run.id} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                <Link href={`/app/workflows/runs/${run.id}`} className="font-medium underline">
                  run {run.id}
                </Link>{" "}
                | status: {run.status} | current_step: {run.current_step_key ?? "-"} | template:{" "}
                {templateNameById.get(run.template_id) ?? run.template_id}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">ワークフロー実行はまだありません。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">生成ドラフト</h2>
        {latestDraft ? (
          <div className="mt-4 space-y-4 text-sm text-slate-700">
            <div>
              <p className="font-medium text-slate-900">要約</p>
              <p className="mt-1">{latestDraft.summary}</p>
            </div>
            {latestDraft.proposed_actions.map((action, idx) => (
              <div key={`${action.to}-${idx}`} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p>
                  <span className="font-medium">provider:</span> {action.provider}
                </p>
                <p>
                  <span className="font-medium">action_type:</span> {action.action_type}
                </p>
                <p>
                  <span className="font-medium">to:</span> {action.to}
                </p>
                <p>
                  <span className="font-medium">subject:</span> {action.subject}
                </p>
                <p className="mt-2 whitespace-pre-wrap">
                  <span className="font-medium">body_text:</span> {action.body_text}
                </p>
              </div>
            ))}
            {latestDraft.risks.length > 0 ? (
              <div>
                <p className="font-medium text-slate-900">リスク</p>
                <ul className="mt-1 list-disc pl-5">
                  {latestDraft.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">まだドラフトが生成されていません。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">ポリシーチェック</h2>
        {latestPolicy ? (
          <div className="mt-3 space-y-2 text-sm">
            <p className="font-medium text-slate-900">POLICY_CHECKED</p>
            <p>
              ステータス:{" "}
              <span className={latestPolicy.status === "block" ? "text-rose-700" : latestPolicy.status === "warn" ? "text-amber-700" : "text-emerald-700"}>
                {latestPolicy.status}
              </span>
            </p>
            {latestPolicy.reasons.length > 0 ? (
              <ul className="list-disc pl-5 text-slate-700">
                {latestPolicy.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-600">ポリシー警告はありません。</p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">まだポリシーチェックがありません。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">ガバナンス評価</h2>
        {governanceEvaluation ? (
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            <p>
              判定:{" "}
              <span className="font-medium text-slate-900">{governanceEvaluation.decision}</span>
            </p>
            <p>risk_score: {governanceEvaluation.riskScore}</p>
            <p>trust_score: {governanceEvaluation.trustScore}</p>
            <p>
              自律設定: {governanceEvaluation.settings.autonomyLevel} / auto_execute=
              {governanceEvaluation.settings.autoExecuteGoogleSendEmail ? "on" : "off"}
            </p>
            <p>当日残予算: {governanceEvaluation.remainingBudget}</p>
            {governanceEvaluation.reasons.length > 0 ? (
              <ul className="list-disc pl-5">
                {governanceEvaluation.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p>制約理由はありません。</p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600">ドラフト生成後に評価が表示されます。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">アクションランナー</h2>
        {existingSuccessForDraft ? (
          <p className="mt-2 text-sm text-emerald-700">現在のドラフトアクションはすでに実行済みです。</p>
        ) : runningAction ? (
          <p className="mt-2 text-sm text-amber-700">実行中です。</p>
        ) : governanceEvaluation?.decision === "allow_auto_execute" && (task.status as string) !== "approved" ? (
          <p className="mt-2 text-sm text-emerald-700">ガバナンス判定により承認バイパスで自動実行できます。</p>
        ) : canExecuteEmailFinal ? (
          <p className="mt-2 text-sm text-slate-700">実行可能です。</p>
        ) : null}
        {latestAction ? (
          <p className="mt-2 text-sm text-slate-700">
            最新アクションの状態: <span className="font-medium">{latestAction.status}</span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-600">まだ実行されたアクションはありません。</p>
        )}
        {actionHistory.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {actionHistory.map((action) => (
              <li key={action.id} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                {action.provider}/{action.action_type} | ステータス: {action.status}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">承認履歴</h2>
        {approvals && approvals.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {approvals.map((approval) => (
              <li key={approval.id} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                ステータス: {approval.status as string}
                {approval.reason ? ` | 理由: ${approval.reason as string}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">まだ承認履歴はありません。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">イベントタイムライン</h2>
        {events && events.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {events.map((event) => (
              <li key={event.id} className="rounded-md border border-slate-200 p-3 text-sm">
                <p className="font-medium text-slate-900">{event.event_type as string}</p>
                <p className="mt-1 text-slate-600">
                  {new Date(event.created_at as string).toLocaleString()}
                </p>
                <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">
                  {JSON.stringify(event.payload_json, null, 2)}
                </pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">イベントはまだ記録されていません。</p>
        )}
      </section>
    </div>
  );
}
