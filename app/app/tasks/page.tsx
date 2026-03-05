import Link from "next/link";
import { createTask } from "@/app/app/tasks/actions";
import { AGENT_EVENTS_TASK_TITLE } from "@/lib/events/taskEvents";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TasksPageProps = {
  searchParams?: Promise<{
    error?: string;
  }>;
};

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const params = searchParams ? await searchParams : {};

  const [{ data: tasks, error: tasksError }, { data: agents, error: agentsError }] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, created_at, agent_id")
      .eq("org_id", orgId)
      .neq("title", AGENT_EVENTS_TASK_TITLE)
      .order("created_at", { ascending: false }),
    supabase
      .from("agents")
      .select("id, name, status")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
  ]);

  if (tasksError) {
    throw new Error(`Failed to load tasks: ${tasksError.message}`);
  }

  if (agentsError) {
    throw new Error(`Failed to load agents: ${agentsError.message}`);
  }

  const agentNameById = new Map<string, string>((agents ?? []).map((agent) => [agent.id as string, agent.name as string]));

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <p className="mt-2 text-sm text-slate-600">Create and track task execution for your current organization.</p>

        {params.error ? (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {params.error}
          </p>
        ) : null}

        <form action={createTask} className="mt-6 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <select name="agent_id" required className="rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">Select agent</option>
              {(agents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id as string} disabled={agent.status !== "active"}>
                  {agent.name as string} ({agent.status as string})
                </option>
              ))}
            </select>
            <input
              type="text"
              name="title"
              required
              placeholder="Task title"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <textarea
            name="input_text"
            rows={4}
            placeholder="Task input"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Create Task
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Task List</h2>
        {tasks && tasks.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {tasks.map((task) => (
              <li key={task.id} className="rounded-md border border-slate-200 p-4">
                <Link href={`/app/tasks/${task.id}`} className="font-medium text-slate-900 hover:underline">
                  {task.title as string}
                </Link>
                <p className="mt-1 text-sm text-slate-600">
                  status: {task.status as string} | agent:{" "}
                  {task.agent_id ? agentNameById.get(task.agent_id as string) ?? "Unassigned" : "Unassigned"}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-slate-600">No tasks yet. Create one above.</p>
        )}
      </section>
    </div>
  );
}
