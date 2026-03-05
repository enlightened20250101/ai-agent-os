import { NextResponse } from "next/server";
import { getOptionalOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { startWorkflowRun } from "@/lib/workflows/orchestrator";

export async function POST(request: Request) {
  const orgContext = await getOptionalOrgContext();
  if (!orgContext) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    task_id?: string;
    template_id?: string;
  } | null;

  const taskId = body?.task_id?.trim();
  const templateId = body?.template_id?.trim();
  if (!taskId || !templateId) {
    return NextResponse.json({ error: "task_id_and_template_id_required" }, { status: 400 });
  }

  const supabase = await createClient();
  try {
    const result = await startWorkflowRun({
      supabase,
      orgId: orgContext.orgId,
      taskId,
      templateId,
      actorId: orgContext.userId
    });

    return NextResponse.json({ workflow_run_id: result.workflowRunId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "workflow_run_start_failed";
    return NextResponse.json({ error: "workflow_run_start_failed", message }, { status: 400 });
  }
}
