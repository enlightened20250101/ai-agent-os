import { NextResponse } from "next/server";
import { evaluateAndMaybeOpenIncident } from "@/lib/governance/incidentAuto";
import { runWithOpsRetry } from "@/lib/governance/jobRetry";
import { createAdminClient } from "@/lib/supabase/admin";

function isAllowedByMode(request: Request) {
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  const expected = process.env.INCIDENT_AUTOMATION_TOKEN ?? process.env.GOV_RECOMMENDATIONS_TOKEN ?? process.env.PLANNER_RUN_TOKEN;
  const received =
    request.headers.get("x-incident-token") ??
    request.headers.get("x-governance-token") ??
    request.headers.get("x-planner-token");

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

  const admin = createAdminClient();

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
      evaluated?: boolean;
      opened?: boolean;
      reason?: string;
      incident_id?: string;
      trigger?: string;
      skipped_circuit?: boolean;
      paused_until?: string | null;
      error?: string;
    }> = [];

    for (const targetOrgId of targets) {
      const retried = await runWithOpsRetry({
        supabase: admin,
        orgId: targetOrgId,
        jobName: "incident_auto_open_batch",
        run: async () =>
          evaluateAndMaybeOpenIncident({
            supabase: admin,
            orgId: targetOrgId,
            actorUserId: null,
            source: "cron"
          })
      });

      if (retried.ok) {
        const result = retried.value;
        results.push({
          org_id: targetOrgId,
          ok: true,
          evaluated: result.evaluated,
          opened: result.opened,
          reason: result.reason,
          incident_id: result.incidentId,
          trigger: result.trigger
        });
      } else {
        if (retried.circuitOpen) {
          results.push({
            org_id: targetOrgId,
            ok: true,
            evaluated: false,
            opened: false,
            reason: "circuit_open",
            skipped_circuit: true,
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
      opened_count: results.filter((item) => item.opened).length,
      results
    });
  }

  const retried = await runWithOpsRetry({
    supabase: admin,
    orgId,
    jobName: "incident_auto_open_single",
    run: async () =>
      evaluateAndMaybeOpenIncident({
        supabase: admin,
        orgId,
        actorUserId: null,
        source: "cron"
      })
  });
  if (retried.ok) {
    const result = retried.value;

    return NextResponse.json({
      ok: true,
      org_id: orgId,
      ...result
    });
  }
  if (retried.circuitOpen) {
    return NextResponse.json({
      ok: true,
      org_id: orgId,
      evaluated: false,
      opened: false,
      reason: "circuit_open",
      skipped_circuit: true,
      paused_until: retried.pausedUntil
    });
  }
  return NextResponse.json({ error: retried.error }, { status: 500 });
}
