import { NextResponse } from "next/server";
import { getLatestOpenIncident } from "@/lib/governance/incidents";
import { runWithOpsRetry } from "@/lib/governance/jobRetry";
import { runPlanner } from "@/lib/planner/runPlanner";
import { createAdminClient } from "@/lib/supabase/admin";

function isAllowedByMode(request: Request) {
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  const expected = process.env.PLANNER_RUN_TOKEN;
  const received = request.headers.get("x-planner-token");
  return Boolean(expected && received && expected === received);
}

export async function POST(request: Request) {
  if (!isAllowedByMode(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const orgId = url.searchParams.get("org_id")?.trim();
  const maxOrgsRaw = Number.parseInt(url.searchParams.get("max_orgs") ?? "20", 10);
  const maxOrgs = Number.isNaN(maxOrgsRaw) ? 20 : Math.max(1, Math.min(200, maxOrgsRaw));
  if (!orgId) {
    const admin = createAdminClient();
    const { data: orgs, error: orgsError } = await admin
      .from("orgs")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(maxOrgs);

    if (orgsError) {
      return NextResponse.json({ error: `orgs lookup failed: ${orgsError.message}` }, { status: 500 });
    }

    const targets = (orgs ?? []).map((row) => row.id as string).filter(Boolean);
    const results: Array<{
      org_id: string;
      ok: boolean;
      created_proposals?: number;
      skipped_circuit?: boolean;
      skipped_dry_run?: boolean;
      skipped_incident?: boolean;
      incident_id?: string;
      incident_severity?: string;
      paused_until?: string | null;
      error?: string;
    }> = [];

    for (const targetOrgId of targets) {
      const openIncident = await getLatestOpenIncident({ supabase: admin, orgId: targetOrgId });
      if (openIncident) {
        results.push({
          org_id: targetOrgId,
          ok: true,
          created_proposals: 0,
          skipped_incident: true,
          incident_id: openIncident.id,
          incident_severity: openIncident.severity
        });
        continue;
      }

      const retried = await runWithOpsRetry({
        supabase: admin,
        orgId: targetOrgId,
        jobName: "planner_run_batch",
        run: async () =>
          runPlanner({
            supabase: admin,
            orgId: targetOrgId,
            actorUserId: null,
            maxProposals: 3
          })
      });
      if (retried.ok) {
        results.push({
          org_id: targetOrgId,
          ok: true,
          created_proposals: retried.value.createdProposals
        });
      } else {
        if (retried.circuitOpen) {
          results.push({
            org_id: targetOrgId,
            ok: true,
            created_proposals: 0,
            skipped_circuit: true,
            paused_until: retried.pausedUntil
          });
          continue;
        }
        if (retried.dryRunProbe) {
          results.push({
            org_id: targetOrgId,
            ok: true,
            created_proposals: 0,
            skipped_dry_run: true,
            paused_until: retried.pausedUntil
          });
          continue;
        }
        results.push({
          org_id: targetOrgId,
          ok: false,
          error: retried.error
        });
      }
    }

    return NextResponse.json({
      ok: true,
      mode: "all_orgs",
      target_count: targets.length,
      success_count: results.filter((item) => item.ok).length,
      failure_count: results.filter((item) => !item.ok).length,
      results
    });
  }

  const admin = createAdminClient();
  const openIncident = await getLatestOpenIncident({ supabase: admin, orgId });
  if (openIncident) {
    return NextResponse.json({
      ok: true,
      skipped_incident: true,
      incident_id: openIncident.id,
      severity: openIncident.severity,
      reason: openIncident.reason
    });
  }

  const retried = await runWithOpsRetry({
    supabase: admin,
    orgId,
    jobName: "planner_run_single",
    run: async () =>
      runPlanner({
        supabase: admin,
        orgId,
        actorUserId: null,
        maxProposals: 3
      })
  });
  if (retried.ok) {
    const result = retried.value;
    return NextResponse.json({
      ok: true,
      planner_run_id: result.plannerRunId,
      created_proposals: result.createdProposals,
      considered_signals: result.consideredSignals
    });
  }
  if (retried.circuitOpen) {
    return NextResponse.json({
      ok: true,
      skipped_circuit: true,
      paused_until: retried.pausedUntil
    });
  }
  if (retried.dryRunProbe) {
    return NextResponse.json({
      ok: true,
      skipped_dry_run: true,
      paused_until: retried.pausedUntil
    });
  }
  return NextResponse.json({ error: retried.error }, { status: 500 });
}
