import { NextResponse } from "next/server";
import { runAutoCaseifyForOrg } from "@/lib/events/autoCaseify";
import { runWithOpsRetry } from "@/lib/governance/jobRetry";
import { createAdminClient } from "@/lib/supabase/admin";

function isAuthorized(request: Request) {
  if (process.env.NODE_ENV === "development") return true;
  const token = request.headers.get("x-events-automation-token");
  const expected = process.env.EVENTS_AUTOMATION_TOKEN ?? process.env.PLANNER_RUN_TOKEN;
  return Boolean(expected && token && token === expected);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const orgId = url.searchParams.get("org_id")?.trim() ?? "";
  const maxOrgsRaw = Number.parseInt(url.searchParams.get("max_orgs") ?? "20", 10);
  const maxOrgs = Number.isNaN(maxOrgsRaw) ? 20 : Math.max(1, Math.min(200, maxOrgsRaw));
  const admin = createAdminClient();

  let targetOrgIds: string[] = [];
  if (orgId) {
    targetOrgIds = [orgId];
  } else {
    const orgsRes = await admin.from("orgs").select("id").order("created_at", { ascending: true }).limit(maxOrgs);
    if (orgsRes.error) {
      return NextResponse.json({ error: orgsRes.error.message }, { status: 500 });
    }
    targetOrgIds = (orgsRes.data ?? []).map((row) => row.id as string).filter(Boolean);
  }

  const results: Array<{
    org_id: string;
    ok: boolean;
    scanned?: number;
    created?: number;
    skipped?: number;
    failed?: number;
    skipped_circuit?: boolean;
    skipped_dry_run?: boolean;
    paused_until?: string | null;
    error?: string;
  }> = [];
  for (const targetOrgId of targetOrgIds) {
    const retried = await runWithOpsRetry({
      supabase: admin,
      orgId: targetOrgId,
      jobName: "events_auto_caseify_batch",
      run: async () =>
        runAutoCaseifyForOrg({
          supabase: admin,
          orgId: targetOrgId,
          actorUserId: null,
          limit: 50
        })
    });
    if (retried.ok) {
      const result = retried.value;
      results.push({
        org_id: targetOrgId,
        ok: true,
        scanned: result.scanned,
        created: result.created,
        skipped: result.skipped,
        failed: result.failed
      });
      continue;
    }
    if (retried.circuitOpen) {
      results.push({
        org_id: targetOrgId,
        ok: true,
        scanned: 0,
        created: 0,
        skipped: 0,
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
        created: 0,
        skipped: 0,
        failed: 0,
        skipped_dry_run: true,
        paused_until: retried.pausedUntil
      });
      continue;
    }
    results.push({
      org_id: targetOrgId,
      ok: false,
      scanned: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      error: retried.error
    });
  }

  return NextResponse.json({
    ok: true,
    target_orgs: targetOrgIds.length,
    success_count: results.filter((row) => row.ok).length,
    failure_count: results.filter((row) => !row.ok).length,
    results
  });
}
