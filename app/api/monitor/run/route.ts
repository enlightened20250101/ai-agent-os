import { NextResponse } from "next/server";
import { runMonitorTick } from "@/lib/monitor/runMonitor";
import { createAdminClient } from "@/lib/supabase/admin";

function isAuthorized(request: Request) {
  if (process.env.NODE_ENV === "development") return true;
  const expected = process.env.MONITOR_RUN_TOKEN;
  const received = request.headers.get("x-monitor-token");
  return Boolean(expected && received && expected === received);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org_id")?.trim();
  const forcePlanner = url.searchParams.get("force_planner") === "1";
  const maxOrgsRaw = Number.parseInt(url.searchParams.get("max_orgs") ?? "20", 10);
  const maxOrgs = Number.isNaN(maxOrgsRaw) ? 20 : Math.max(1, Math.min(200, maxOrgsRaw));

  if (orgId) {
    try {
      const result = await runMonitorTick({
        supabase: admin,
        orgId,
        actorUserId: null,
        triggerSource: "api",
        forcePlanner
      });
      return NextResponse.json({ ok: true, org_id: orgId, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "monitor run failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const { data: orgs, error: orgsError } = await admin
    .from("orgs")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(maxOrgs);
  if (orgsError) {
    return NextResponse.json({ error: `org lookup failed: ${orgsError.message}` }, { status: 500 });
  }

  const targets = (orgs ?? []).map((row) => row.id as string).filter(Boolean);
  const results: Array<Record<string, unknown>> = [];
  for (const targetOrgId of targets) {
    try {
      const result = await runMonitorTick({
        supabase: admin,
        orgId: targetOrgId,
        actorUserId: null,
        triggerSource: "cron",
        forcePlanner
      });
      results.push({ org_id: targetOrgId, ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "monitor run failed";
      results.push({ org_id: targetOrgId, ok: false, error: message });
    }
  }

  return NextResponse.json({
    ok: true,
    mode: "all_orgs",
    target_count: targets.length,
    success_count: results.filter((row) => row.ok === true).length,
    failure_count: results.filter((row) => row.ok !== true).length,
    results
  });
}
