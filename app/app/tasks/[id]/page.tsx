import Link from "next/link";
import { notFound } from "next/navigation";
import { requestApproval, setTaskReadyForApproval } from "@/app/app/tasks/[id]/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TaskDetailsPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ error?: string }>;
};

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
          <form action={setTaskReadyForApproval}>
            <input type="hidden" name="task_id" value={task.id as string} />
            <button
              type="submit"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              Mark Ready for Approval
            </button>
          </form>
          <form action={requestApproval}>
            <input type="hidden" name="task_id" value={task.id as string} />
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800"
            >
              Request Approval
            </button>
          </form>
        </div>
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
