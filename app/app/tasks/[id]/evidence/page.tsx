import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/app/app/tasks/[id]/evidence/PrintButton";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type EvidencePageProps = {
  params: Promise<{ id: string }>;
};

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function getLatestEvent(events: Array<{ event_type: string; payload_json: unknown }>, eventType: string) {
  return [...events].reverse().find((event) => event.event_type === eventType) ?? null;
}

type DraftView = {
  summary: string;
  proposedActions: Array<{
    provider: string;
    actionType: string;
    to: string;
    subject: string;
    bodyText: string;
  }>;
  risks: string[];
  model: string | null;
  latencyMs: number | null;
};

function parseDraft(eventPayload: unknown): DraftView | null {
  const payload = asObject(eventPayload);
  if (!payload) return null;
  const output = asObject(payload.output);
  if (!output || typeof output.summary !== "string") return null;
  const proposedRaw = Array.isArray(output.proposed_actions) ? output.proposed_actions : [];
  const risksRaw = Array.isArray(output.risks) ? output.risks : [];
  const proposedActions = proposedRaw
    .map((item) => {
      const row = asObject(item);
      if (
        !row ||
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
        actionType: row.action_type,
        to: row.to,
        subject: row.subject,
        bodyText: row.body_text
      };
    })
    .filter((v): v is DraftView["proposedActions"][number] => v !== null);

  const model = typeof payload.model === "string" ? payload.model : null;
  const latencyMs = typeof payload.latency_ms === "number" ? payload.latency_ms : null;

  return {
    summary: output.summary,
    proposedActions,
    risks: risksRaw.filter((item): item is string => typeof item === "string"),
    model,
    latencyMs
  };
}

type PolicyView = {
  status: "pass" | "warn" | "block" | "unknown";
  reasons: string[];
  evaluatedAction: unknown;
};

function parsePolicy(eventPayload: unknown): PolicyView | null {
  const payload = asObject(eventPayload);
  if (!payload) return null;
  const status =
    payload.status === "pass" || payload.status === "warn" || payload.status === "block"
      ? payload.status
      : "unknown";
  const reasons = Array.isArray(payload.reasons)
    ? payload.reasons.filter((item): item is string => typeof item === "string")
    : [];
  return {
    status,
    reasons,
    evaluatedAction: payload.evaluated_action ?? null
  };
}

export default async function EvidencePage({ params }: EvidencePageProps) {
  const { id } = await params;
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const [
    { data: task, error: taskError },
    { data: events, error: eventsError },
    { data: approvals, error: approvalsError },
    { data: actions, error: actionsError }
  ] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, created_at, created_by_user_id, agent_id")
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase
      .from("task_events")
      .select("id, created_at, event_type, actor_type, actor_id, payload_json")
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
      .select("id, provider, action_type, status, request_json, result_json, created_at")
      .eq("org_id", orgId)
      .eq("task_id", id)
      .order("created_at", { ascending: false })
  ]);

  if (taskError) throw new Error(`Failed to load task: ${taskError.message}`);
  if (eventsError) throw new Error(`Failed to load events: ${eventsError.message}`);
  if (approvalsError) throw new Error(`Failed to load approvals: ${approvalsError.message}`);
  if (actionsError) throw new Error(`Failed to load actions: ${actionsError.message}`);
  if (!task) notFound();

  const [agentRes, creatorRes] = await Promise.all([
    task.agent_id
      ? supabase
          .from("agents")
          .select("id, name, role_key")
          .eq("id", task.agent_id as string)
          .eq("org_id", orgId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    task.created_by_user_id
      ? supabase.auth.admin.getUserById(task.created_by_user_id as string)
      : Promise.resolve({ data: { user: null }, error: null })
  ]);

  const { data: exceptionCasesRaw, error: exceptionCasesError } = await supabase
    .from("exception_cases")
    .select("id, kind, ref_id, status, owner_user_id, note, due_at, last_alerted_at, updated_at, created_at")
    .eq("org_id", orgId)
    .eq("task_id", id)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (exceptionCasesError && !isMissingTableError(exceptionCasesError.message, "exception_cases")) {
    throw new Error(`Failed to load exception cases: ${exceptionCasesError.message}`);
  }
  const exceptionCases =
    exceptionCasesError && isMissingTableError(exceptionCasesError.message, "exception_cases")
      ? []
      : (exceptionCasesRaw ?? []);

  const exceptionCaseIds = exceptionCases.map((row) => row.id as string).filter(Boolean);
  const exceptionCaseById = new Map(
    exceptionCases.map((row) => [
      row.id as string,
      {
        kind: row.kind as string,
        refId: row.ref_id as string
      }
    ])
  );
  const exceptionCaseEvents =
    exceptionCaseIds.length > 0
      ? await (async () => {
          const { data, error } = await supabase
            .from("exception_case_events")
            .select("id, exception_case_id, actor_user_id, event_type, payload_json, created_at")
            .eq("org_id", orgId)
            .in("exception_case_id", exceptionCaseIds)
            .order("created_at", { ascending: false })
            .limit(200);
          if (error) {
            if (isMissingTableError(error.message, "exception_case_events")) {
              return [];
            }
            throw new Error(`Failed to load exception case events: ${error.message}`);
          }
          return data ?? [];
        })()
      : [];

  const eventRows = events ?? [];
  const latestModel = getLatestEvent(eventRows, "MODEL_INFERRED");
  const latestPolicy = getLatestEvent(eventRows, "POLICY_CHECKED");
  const latestSlackPosted = getLatestEvent(eventRows, "SLACK_APPROVAL_POSTED");
  const proposalOriginEvent = eventRows.find((event) => {
    if (event.event_type !== "TASK_CREATED") return false;
    const payload = asObject(event.payload_json);
    return typeof payload?.proposal_id === "string";
  });
  const proposalOriginId = (() => {
    const payload = asObject(proposalOriginEvent?.payload_json);
    return typeof payload?.proposal_id === "string" ? payload.proposal_id : null;
  })();

  const draft = parseDraft(latestModel?.payload_json);
  const policy = parsePolicy(latestPolicy?.payload_json);
  const slackPayload = asObject(latestSlackPosted?.payload_json);

  return (
    <div className="mx-auto max-w-5xl space-y-6 print:max-w-none print:text-black">
      <style>{`
        @media print {
          .print-hidden { display: none !important; }
          body { background: white !important; }
          details { page-break-inside: avoid; }
        }
      `}</style>

      <header className="rounded-lg border border-slate-300 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-slate-500">AI Agent OS 証跡パック</p>
            <h1 className="mt-1 text-2xl font-semibold">タスク証跡レポート</h1>
            <p className="mt-2 text-sm text-slate-600">生成日時 {new Date().toLocaleString()}</p>
          </div>
          <div className="flex gap-2 print-hidden">
            <Link
              href={`/app/tasks/${task.id as string}`}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
            >
              タスクへ戻る
            </Link>
            <PrintButton />
          </div>
        </div>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">A. タスク概要</h2>
        <div className="mt-3 space-y-1 text-sm text-slate-700">
          <p>タスクID: {task.id as string}</p>
          <p>タイトル: {task.title as string}</p>
          <p>ステータス: {task.status as string}</p>
          <p>作成日時: {new Date(task.created_at as string).toLocaleString()}</p>
          <p>作成ユーザーID: {task.created_by_user_id as string}</p>
          <p>作成ユーザーメール: {creatorRes.data.user?.email ?? "（取得不可）"}</p>
          <p>エージェント: {agentRes.data?.name ?? "（なし）"}</p>
          <p>エージェント role_key: {agentRes.data?.role_key ?? "（なし）"}</p>
          <p>
            提案元:{" "}
            {proposalOriginId ? (
              <>
                {proposalOriginId} (
                <Link href="/app/proposals" className="underline">
                  提案一覧を見る
                </Link>
                )
              </>
            ) : (
              "（なし）"
            )}
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">B. ドラフト（最新 MODEL_INFERRED）</h2>
        {draft ? (
          <div className="mt-3 space-y-3 text-sm text-slate-700">
            <p>モデル: {draft.model ?? "（不明）"}</p>
            <p>遅延ms: {draft.latencyMs ?? "（不明）"}</p>
            <p>要約: {draft.summary}</p>
            <p className="font-medium">リスク:</p>
            {draft.risks.length > 0 ? (
              <ul className="list-disc pl-5">
                {draft.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            ) : (
              <p>（なし）</p>
            )}
            <p className="font-medium">提案アクション:</p>
            {draft.proposedActions.length > 0 ? (
              <ul className="space-y-2">
                {draft.proposedActions.map((action, idx) => (
                  <li key={`${action.to}-${idx}`} className="rounded-md border border-slate-200 p-3">
                    <p>プロバイダー: {action.provider}</p>
                    <p>アクション種別: {action.actionType}</p>
                    <p>宛先: {action.to}</p>
                    <p>件名: {action.subject}</p>
                    <p className="whitespace-pre-wrap">本文: {action.bodyText}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>（なし）</p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">MODEL_INFERRED イベントが見つかりません。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">C. ポリシー（最新 POLICY_CHECKED）</h2>
        {policy ? (
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            <p>ステータス: {policy.status}</p>
            <p className="font-medium">理由:</p>
            {policy.reasons.length > 0 ? (
              <ul className="list-disc pl-5">
                {policy.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p>（なし）</p>
            )}
            <details>
              <summary className="cursor-pointer font-medium">評価対象アクション</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                {pretty(policy.evaluatedAction)}
              </pre>
            </details>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">POLICY_CHECKED イベントが見つかりません。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">D. 承認</h2>
        {approvals && approvals.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm text-slate-700">
            {approvals.map((approval) => (
              <li key={approval.id} className="rounded-md border border-slate-200 p-3">
                <p>ステータス: {approval.status as string}</p>
                <p>依頼者: {approval.requested_by as string}</p>
                <p>承認者ユーザーID: {(approval.approver_user_id as string) ?? "（なし）"}</p>
                <p>作成日時: {new Date(approval.created_at as string).toLocaleString()}</p>
                <p>
                  判断日時:{" "}
                  {approval.decided_at ? new Date(approval.decided_at as string).toLocaleString() : "（なし）"}
                </p>
                <p>理由: {(approval.reason as string) ?? "（なし）"}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">承認履歴はありません。</p>
        )}
        <div className="mt-4 text-sm text-slate-700">
          <p className="font-medium">Slack承認投稿</p>
          {slackPayload ? (
            <p>
              チャネルID: {String(slackPayload.channel_id ?? "（不明）")} | slack_ts:{" "}
              {String(slackPayload.slack_ts ?? "（不明）")}
            </p>
          ) : (
            <p>（なし）</p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">E. 実行（Actions）</h2>
        {actions && actions.length > 0 ? (
          <ul className="mt-3 space-y-3 text-sm text-slate-700">
            {actions.map((action) => {
              const resultObj = asObject(action.result_json);
              return (
                <li key={action.id} className="rounded-md border border-slate-200 p-3">
                  <p>
                    {action.provider as string}/{action.action_type as string} | ステータス:{" "}
                    {action.status as string}
                  </p>
                  <p>作成日時: {new Date(action.created_at as string).toLocaleString()}</p>
                  <p>GmailメッセージID: {String(resultObj?.gmail_message_id ?? "（なし）")}</p>
                  <details className="mt-2">
                    <summary className="cursor-pointer font-medium">リクエストJSON</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                      {pretty(action.request_json)}
                    </pre>
                  </details>
                  <details className="mt-2">
                    <summary className="cursor-pointer font-medium">結果JSON</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                      {pretty(action.result_json)}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">実行されたアクションはありません。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">F. イベントタイムライン（raw）</h2>
        {eventRows.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="px-2 py-2">作成日時</th>
                  <th className="px-2 py-2">イベント種別</th>
                  <th className="px-2 py-2">アクター種別</th>
                  <th className="px-2 py-2">アクターID</th>
                  <th className="px-2 py-2">ペイロードJSON</th>
                </tr>
              </thead>
              <tbody>
                {eventRows.map((event) => (
                  <tr key={event.id as string} className="border-b border-slate-100 align-top">
                    <td className="px-2 py-2 whitespace-nowrap">
                      {new Date(event.created_at as string).toLocaleString()}
                    </td>
                    <td className="px-2 py-2 font-medium">{event.event_type as string}</td>
                    <td className="px-2 py-2">{event.actor_type as string}</td>
                    <td className="px-2 py-2">{(event.actor_id as string) ?? "（なし）"}</td>
                    <td className="px-2 py-2">
                      <details>
                        <summary className="cursor-pointer">ペイロードを見る</summary>
                        <pre className="mt-2 max-w-xl overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                          {pretty(event.payload_json)}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">イベント記録はありません。</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">G. 例外ケース監査</h2>
        {exceptionCases.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm text-slate-700">
            {exceptionCases.map((row) => (
              <li key={row.id as string} className="rounded-md border border-slate-200 p-3">
                <p>
                  {row.kind as string}/{row.ref_id as string} | status: {row.status as string}
                </p>
                <p>
                  owner: {(row.owner_user_id as string) ?? "unassigned"} | due:{" "}
                  {row.due_at ? new Date(row.due_at as string).toLocaleString() : "（なし）"}
                </p>
                <p>
                  last_alerted:{" "}
                  {row.last_alerted_at ? new Date(row.last_alerted_at as string).toLocaleString() : "（なし）"}
                </p>
                <p>note: {(row.note as string) || "（なし）"}</p>
                <p>updated_at: {new Date(row.updated_at as string).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">このタスクに紐づく例外ケースはありません。</p>
        )}
        <div className="mt-4">
          <p className="text-sm font-medium text-slate-900">Exception Case Events</p>
          {exceptionCaseEvents.length > 0 ? (
            <ul className="mt-2 space-y-2 text-sm text-slate-700">
              {exceptionCaseEvents.map((event) => {
                const related = exceptionCaseById.get(event.exception_case_id as string) ?? null;
                return (
                  <li key={event.id as string} className="rounded-md border border-slate-200 p-3">
                    <p>
                      {event.event_type as string} |{" "}
                      {related
                        ? `${related.kind}/${related.refId}`
                        : (event.exception_case_id as string)}
                    </p>
                    <p>
                      actor: {(event.actor_user_id as string) ?? "system"} | at:{" "}
                      {new Date(event.created_at as string).toLocaleString()}
                    </p>
                    <details className="mt-2">
                      <summary className="cursor-pointer font-medium">payload JSON</summary>
                      <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                        {pretty(event.payload_json)}
                      </pre>
                    </details>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-600">例外ケースイベントはありません。</p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">H. 完全性ノート</h2>
        <p className="mt-3 text-sm text-slate-700">
          生成日時 {new Date().toLocaleString()}。LLM出力は保存前に正規化され、
          すべてのワークフロー変更は task_events/actions に監査記録されます。
        </p>
      </section>
    </div>
  );
}
