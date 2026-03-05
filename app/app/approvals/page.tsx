import Link from "next/link";
import { decideApproval } from "@/app/app/approvals/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ApprovalsPageProps = {
  searchParams?: Promise<{ error?: string }>;
};

type ApprovalRow = {
  id: string;
  task_id: string;
  status: string;
  created_at: string;
  reason: string | null;
};

export default async function ApprovalsPage({ searchParams }: ApprovalsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};

  const { data: approvals, error } = await supabase
    .from("approvals")
    .select("id, task_id, status, created_at, reason")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load approvals: ${error.message}`);
  }

  const pendingApprovals = (approvals ?? []) as ApprovalRow[];
  const taskIds = pendingApprovals.map((approval) => approval.task_id);

  let taskTitleById = new Map<string, string>();
  if (taskIds.length > 0) {
    const { data: tasks, error: tasksError } = await supabase
      .from("tasks")
      .select("id, title")
      .in("id", taskIds)
      .eq("org_id", orgId);

    if (tasksError) {
      throw new Error(`Failed to load approval tasks: ${tasksError.message}`);
    }

    taskTitleById = new Map<string, string>((tasks ?? []).map((task) => [task.id as string, task.title as string]));
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">Approvals</h1>
      <p className="mt-2 text-sm text-slate-600">Pending approvals for your organization.</p>

      {sp.error ? (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {sp.error}
        </p>
      ) : null}

      {pendingApprovals.length > 0 ? (
        <ul className="mt-5 space-y-4">
          {pendingApprovals.map((approval) => (
            <li key={approval.id} className="rounded-md border border-slate-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-700">
                  Task:{" "}
                  <Link href={`/app/tasks/${approval.task_id}`} className="font-medium">
                    {taskTitleById.get(approval.task_id) ?? approval.task_id}
                  </Link>
                </p>
                <p className="text-xs text-slate-500">
                  requested {new Date(approval.created_at).toLocaleString()}
                </p>
              </div>

              <form action={decideApproval} className="mt-3 flex flex-col gap-3 md:flex-row md:items-center">
                <input type="hidden" name="approval_id" value={approval.id} />
                <input
                  type="text"
                  name="reason"
                  placeholder="Reason (optional)"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm md:max-w-md"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    name="decision"
                    value="approved"
                    className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600"
                  >
                    Approve
                  </button>
                  <button
                    type="submit"
                    name="decision"
                    value="rejected"
                    className="rounded-md bg-rose-700 px-3 py-2 text-sm text-white hover:bg-rose-600"
                  >
                    Reject
                  </button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-slate-600">No pending approvals.</p>
      )}
    </section>
  );
}
