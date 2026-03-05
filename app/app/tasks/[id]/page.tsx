import Link from "next/link";
import { notFound } from "next/navigation";
import { generateDraft, requestApproval, setTaskReadyForApproval } from "@/app/app/tasks/[id]/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TaskDetailsPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ error?: string }>;
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

export default async function TaskDetailsPage({ params, searchParams }: TaskDetailsPageProps) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const [{ data: task, error: taskError }, { data: events, error: eventsError }, { data: approvals, error: approvalsError }] =
    await Promise.all([
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

  if (!task) {
    notFound();
  }

  const latestModelEvent = [...(events ?? [])].reverse().find((event) => event.event_type === "MODEL_INFERRED");
  const latestPolicyEvent = [...(events ?? [])].reverse().find((event) => event.event_type === "POLICY_CHECKED");

  const latestDraft = parseDraftPayload(latestModelEvent?.payload_json);
  const latestPolicy = parsePolicyPayload(latestPolicyEvent?.payload_json);
  const canRequestApproval = Boolean(latestDraft && latestPolicy && latestPolicy.status !== "block");

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{task.title as string}</h1>
            <p className="mt-2 text-sm text-slate-600">Status: {task.status as string}</p>
          </div>
          <Link href="/app/tasks" className="text-sm">
            Back to tasks
          </Link>
        </div>

        {sp.error ? (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {sp.error}
          </p>
        ) : null}

        <div className="mt-4 rounded-md bg-slate-50 p-4">
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{task.input_text as string}</p>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <form action={generateDraft}>
            <input type="hidden" name="task_id" value={task.id as string} />
            <button
              type="submit"
              className="rounded-md bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-600"
            >
              Generate Draft
            </button>
          </form>
          <form action={setTaskReadyForApproval}>
            <input type="hidden" name="task_id" value={task.id as string} />
            <button
              type="submit"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              Mark Ready for Approval
            </button>
          </form>
          {canRequestApproval ? (
            <form action={requestApproval}>
              <input type="hidden" name="task_id" value={task.id as string} />
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800"
              >
                Request Approval
              </button>
            </form>
          ) : (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {latestDraft
                ? latestPolicy?.status === "block"
                  ? "Approval is disabled because policy status is block."
                  : "Run policy check by generating a draft."
                : "Generate a draft before requesting approval."}
            </p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Generated Draft</h2>
        {latestDraft ? (
          <div className="mt-4 space-y-4 text-sm text-slate-700">
            <div>
              <p className="font-medium text-slate-900">Summary</p>
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
                <p className="font-medium text-slate-900">Risks</p>
                <ul className="mt-1 list-disc pl-5">
                  {latestDraft.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No draft generated yet.</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Policy Check</h2>
        {latestPolicy ? (
          <div className="mt-3 space-y-2 text-sm">
            <p className="font-medium text-slate-900">POLICY_CHECKED</p>
            <p>
              status:{" "}
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
              <p className="text-slate-600">No policy warnings.</p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No policy check yet.</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Approval History</h2>
        {approvals && approvals.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {approvals.map((approval) => (
              <li key={approval.id} className="rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                status: {approval.status as string}
                {approval.reason ? ` | reason: ${approval.reason as string}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No approvals yet.</p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Event Timeline</h2>
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
          <p className="mt-3 text-sm text-slate-600">No events recorded yet.</p>
        )}
      </section>
    </div>
  );
}
