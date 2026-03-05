import { NextResponse } from "next/server";
import { getOptionalOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function isMissingColumnError(message: string, columnName: string) {
  return (
    message.includes(`Could not find the '${columnName}' column`) ||
    message.includes(`column task_proposals.${columnName} does not exist`)
  );
}

export async function GET(_request: Request, context: RouteContext) {
  const orgContext = await getOptionalOrgContext();
  if (!orgContext) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_run_id" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: run, error: runError } = await supabase
    .from("planner_runs")
    .select("id, status, started_at, finished_at, summary_json, created_at")
    .eq("id", id)
    .eq("org_id", orgContext.orgId)
    .maybeSingle();

  if (runError) {
    return NextResponse.json({ error: "failed_to_load_run", message: runError.message }, { status: 500 });
  }
  if (!run) {
    return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  }

  let { data: proposals, error: proposalsError } = await supabase
    .from("task_proposals")
    .select(
      "id, title, status, source, policy_status, policy_reasons, priority_score, estimated_impact_json, created_at"
    )
    .eq("org_id", orgContext.orgId)
    .eq("planner_run_id", id)
    .order("priority_score", { ascending: false })
    .order("created_at", { ascending: false });

  if (
    proposalsError &&
    (isMissingColumnError(proposalsError.message, "planner_run_id") ||
      isMissingColumnError(proposalsError.message, "priority_score") ||
      isMissingColumnError(proposalsError.message, "estimated_impact_json"))
  ) {
    const fallback = await supabase
      .from("task_proposals")
      .select("id, title, status, source, policy_status, policy_reasons, created_at")
      .eq("org_id", orgContext.orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    proposals = (fallback.data ?? []).map((row) => ({
      ...row,
      priority_score: 0,
      estimated_impact_json: {}
    }));
    proposalsError = fallback.error;
  }

  if (proposalsError) {
    return NextResponse.json(
      { error: "failed_to_load_proposals", message: proposalsError.message },
      { status: 500 }
    );
  }

  const proposalIds = (proposals ?? []).map((row) => row.id as string).filter(Boolean);
  const [proposalEventsRes, runEventsRes] = await Promise.all([
    proposalIds.length > 0
      ? supabase
          .from("proposal_events")
          .select("id, proposal_id, event_type, payload_json, created_at")
          .eq("org_id", orgContext.orgId)
          .in("proposal_id", proposalIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("proposal_events")
      .select("id, proposal_id, event_type, payload_json, created_at")
      .eq("org_id", orgContext.orgId)
      .in("event_type", ["PLANNER_RUN_STARTED", "PLANNER_RUN_FINISHED"])
      .contains("payload_json", { planner_run_id: id })
      .order("created_at", { ascending: true })
  ]);

  if (proposalEventsRes.error) {
    return NextResponse.json(
      { error: "failed_to_load_proposal_events", message: proposalEventsRes.error.message },
      { status: 500 }
    );
  }
  if (runEventsRes.error) {
    return NextResponse.json(
      { error: "failed_to_load_run_events", message: runEventsRes.error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    run,
    proposals: proposals ?? [],
    events: {
      run_events: runEventsRes.data ?? [],
      proposal_events: proposalEventsRes.data ?? []
    }
  });
}
