import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/app/app/tasks/[id]/evidence/PrintButton";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type EvidencePageProps = {
  params: Promise<{ id: string }>;
};

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

  const eventRows = events ?? [];
  const latestModel = getLatestEvent(eventRows, "MODEL_INFERRED");
  const latestPolicy = getLatestEvent(eventRows, "POLICY_CHECKED");
  const latestSlackPosted = getLatestEvent(eventRows, "SLACK_APPROVAL_POSTED");

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
            <p className="text-sm uppercase tracking-wide text-slate-500">AI Agent OS Evidence Pack</p>
            <h1 className="mt-1 text-2xl font-semibold">Task Evidence Report</h1>
            <p className="mt-2 text-sm text-slate-600">
              Evidence generated at {new Date().toLocaleString()}
            </p>
          </div>
          <div className="flex gap-2 print-hidden">
            <Link
              href={`/app/tasks/${task.id as string}`}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
            >
              Back to task
            </Link>
            <PrintButton />
          </div>
        </div>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">A. Task Summary</h2>
        <div className="mt-3 space-y-1 text-sm text-slate-700">
          <p>task id: {task.id as string}</p>
          <p>title: {task.title as string}</p>
          <p>status: {task.status as string}</p>
          <p>created_at: {new Date(task.created_at as string).toLocaleString()}</p>
          <p>created_by_user_id: {task.created_by_user_id as string}</p>
          <p>created_by_email: {creatorRes.data.user?.email ?? "(not available)"}</p>
          <p>agent: {agentRes.data?.name ?? "(none)"}</p>
          <p>agent role_key: {agentRes.data?.role_key ?? "(none)"}</p>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">B. Draft (latest MODEL_INFERRED)</h2>
        {draft ? (
          <div className="mt-3 space-y-3 text-sm text-slate-700">
            <p>model: {draft.model ?? "(unknown)"}</p>
            <p>latency_ms: {draft.latencyMs ?? "(unknown)"}</p>
            <p>summary: {draft.summary}</p>
            <p className="font-medium">risks:</p>
            {draft.risks.length > 0 ? (
              <ul className="list-disc pl-5">
                {draft.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            ) : (
              <p>(none)</p>
            )}
            <p className="font-medium">proposed_actions:</p>
            {draft.proposedActions.length > 0 ? (
              <ul className="space-y-2">
                {draft.proposedActions.map((action, idx) => (
                  <li key={`${action.to}-${idx}`} className="rounded-md border border-slate-200 p-3">
                    <p>provider: {action.provider}</p>
                    <p>action_type: {action.actionType}</p>
                    <p>to: {action.to}</p>
                    <p>subject: {action.subject}</p>
                    <p className="whitespace-pre-wrap">body_text: {action.bodyText}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>(none)</p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No MODEL_INFERRED event found.</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">C. Policy (latest POLICY_CHECKED)</h2>
        {policy ? (
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            <p>status: {policy.status}</p>
            <p className="font-medium">reasons:</p>
            {policy.reasons.length > 0 ? (
              <ul className="list-disc pl-5">
                {policy.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p>(none)</p>
            )}
            <details>
              <summary className="cursor-pointer font-medium">evaluated_action</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                {pretty(policy.evaluatedAction)}
              </pre>
            </details>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No POLICY_CHECKED event found.</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">D. Approval</h2>
        {approvals && approvals.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm text-slate-700">
            {approvals.map((approval) => (
              <li key={approval.id} className="rounded-md border border-slate-200 p-3">
                <p>status: {approval.status as string}</p>
                <p>requested_by: {approval.requested_by as string}</p>
                <p>approver_user_id: {(approval.approver_user_id as string) ?? "(none)"}</p>
                <p>created_at: {new Date(approval.created_at as string).toLocaleString()}</p>
                <p>
                  decided_at:{" "}
                  {approval.decided_at ? new Date(approval.decided_at as string).toLocaleString() : "(none)"}
                </p>
                <p>reason: {(approval.reason as string) ?? "(none)"}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No approvals recorded.</p>
        )}
        <div className="mt-4 text-sm text-slate-700">
          <p className="font-medium">Slack approval post</p>
          {slackPayload ? (
            <p>
              channel_id: {String(slackPayload.channel_id ?? "(unknown)")} | slack_ts:{" "}
              {String(slackPayload.slack_ts ?? "(unknown)")}
            </p>
          ) : (
            <p>(none)</p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">E. Execution (Actions)</h2>
        {actions && actions.length > 0 ? (
          <ul className="mt-3 space-y-3 text-sm text-slate-700">
            {actions.map((action) => {
              const resultObj = asObject(action.result_json);
              return (
                <li key={action.id} className="rounded-md border border-slate-200 p-3">
                  <p>
                    {action.provider as string}/{action.action_type as string} | status:{" "}
                    {action.status as string}
                  </p>
                  <p>created_at: {new Date(action.created_at as string).toLocaleString()}</p>
                  <p>gmail_message_id: {String(resultObj?.gmail_message_id ?? "(none)")}</p>
                  <details className="mt-2">
                    <summary className="cursor-pointer font-medium">request_json</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                      {pretty(action.request_json)}
                    </pre>
                  </details>
                  <details className="mt-2">
                    <summary className="cursor-pointer font-medium">result_json</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                      {pretty(action.result_json)}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No actions executed.</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">F. Event Timeline (raw)</h2>
        {eventRows.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="px-2 py-2">created_at</th>
                  <th className="px-2 py-2">event_type</th>
                  <th className="px-2 py-2">actor_type</th>
                  <th className="px-2 py-2">actor_id</th>
                  <th className="px-2 py-2">payload_json</th>
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
                    <td className="px-2 py-2">{(event.actor_id as string) ?? "(none)"}</td>
                    <td className="px-2 py-2">
                      <details>
                        <summary className="cursor-pointer">view payload</summary>
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
          <p className="mt-3 text-sm text-slate-600">No events recorded.</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">G. Integrity Notes</h2>
        <p className="mt-3 text-sm text-slate-700">
          Evidence generated at {new Date().toLocaleString()}. LLM outputs are normalized before
          persistence, and all workflow mutations are audited in task_events/actions.
        </p>
      </section>
    </div>
  );
}
