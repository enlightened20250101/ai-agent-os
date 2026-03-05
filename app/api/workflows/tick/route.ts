import { NextResponse } from "next/server";
import { runWithOpsRetry } from "@/lib/governance/jobRetry";
import { createAdminClient } from "@/lib/supabase/admin";
import { tickWorkflowRuns } from "@/lib/workflows/orchestrator";

function isAllowedByMode(request: Request) {
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  const expected = process.env.WORKFLOW_TICK_TOKEN ?? process.env.PLANNER_RUN_TOKEN;
  const received = request.headers.get("x-workflow-token") ?? request.headers.get("x-planner-token");
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
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
  const limit = Number.isNaN(limitRaw) ? 10 : Math.max(1, Math.min(100, limitRaw));

  const admin = createAdminClient();
  const actorId = "system:workflow_tick";

  if (!orgId) {
    const { data: orgs, error: orgsError } = await admin
      .from("orgs")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(maxOrgs);

    if (orgsError) {
      return NextResponse.json({ error: `org lookup failed: ${orgsError.message}` }, { status: 500 });
    }

    const targets = (orgs ?? []).map((row) => row.id as string).filter(Boolean);
    const results: Array<{
      org_id: string;
      ok: boolean;
      scanned?: number;
      completed?: number;
      running?: number;
      failed?: number;
      skipped_circuit?: boolean;
      skipped_dry_run?: boolean;
      paused_until?: string | null;
      error?: string;
    }> = [];

    for (const targetOrgId of targets) {
      const retried = await runWithOpsRetry({
        supabase: admin,
        orgId: targetOrgId,
        jobName: "workflow_tick_batch",
        run: async () =>
          tickWorkflowRuns({
            supabase: admin,
            orgId: targetOrgId,
            actorId,
            limit
          })
      });

      if (retried.ok) {
        const tick = retried.value;
        results.push({
          org_id: targetOrgId,
          ok: true,
          scanned: tick.scanned,
          completed: tick.completed,
          running: tick.running,
          failed: tick.failed
        });
      } else {
        if (retried.circuitOpen) {
          results.push({
            org_id: targetOrgId,
            ok: true,
            scanned: 0,
            completed: 0,
            running: 0,
            failed: 0,
            skipped_circuit: true,
            paused_until: retried.pausedUntil
          });
          continue;
        }
        if (retried.dryRunProbe) {
          results.push({
            org_id: targetOrgId,
            ok: true,
            scanned: 0,
            completed: 0,
            running: 0,
            failed: 0,
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

  const retried = await runWithOpsRetry({
    supabase: admin,
    orgId,
    jobName: "workflow_tick_single",
    run: async () =>
      tickWorkflowRuns({
        supabase: admin,
        orgId,
        actorId,
        limit
      })
  });
  if (retried.ok) {
    const tick = retried.value;

    return NextResponse.json({
      ok: true,
      org_id: orgId,
      scanned: tick.scanned,
      completed: tick.completed,
      running: tick.running,
      failed: tick.failed,
      results: tick.results
    });
  }
  if (retried.circuitOpen) {
    return NextResponse.json({
      ok: true,
      org_id: orgId,
      scanned: 0,
      completed: 0,
      running: 0,
      failed: 0,
      skipped_circuit: true,
      paused_until: retried.pausedUntil,
      results: []
    });
  }
  if (retried.dryRunProbe) {
    return NextResponse.json({
      ok: true,
      org_id: orgId,
      scanned: 0,
      completed: 0,
      running: 0,
      failed: 0,
      skipped_dry_run: true,
      paused_until: retried.pausedUntil,
      results: []
    });
  }
  return NextResponse.json({ error: retried.error }, { status: 500 });
}
