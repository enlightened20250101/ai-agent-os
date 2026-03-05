import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function isEnabled() {
  return process.env.NODE_ENV === "test" || process.env.E2E_MODE === "1";
}

function isMissingColumnError(message: string) {
  return message.includes("column") && message.includes("does not exist");
}

type SeedBody = {
  orgId?: string;
  jobName?: string;
  stage?: "active" | "paused" | "dry_run";
  consecutiveFailures?: number;
  pausedMinutes?: number;
  dryRunMinutes?: number;
  lastError?: string;
};

export async function POST(request: Request) {
  if (!isEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const expectedToken = process.env.E2E_CLEANUP_TOKEN;
  const providedToken = request.headers.get("x-e2e-cleanup-token");
  if (!expectedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as SeedBody | null;
  const orgId = body?.orgId?.trim();
  const jobName = body?.jobName?.trim() || "planner_run_single";
  const stage = body?.stage ?? "paused";
  const consecutiveFailuresRaw = Number(body?.consecutiveFailures ?? 3);
  const consecutiveFailures = Number.isFinite(consecutiveFailuresRaw)
    ? Math.max(0, Math.min(999, consecutiveFailuresRaw))
    : 3;
  const pausedMinutesRaw = Number(body?.pausedMinutes ?? 30);
  const pausedMinutes = Number.isFinite(pausedMinutesRaw) ? Math.max(1, Math.min(24 * 60, pausedMinutesRaw)) : 30;
  const dryRunMinutesRaw = Number(body?.dryRunMinutes ?? 10);
  const dryRunMinutes = Number.isFinite(dryRunMinutesRaw)
    ? Math.max(1, Math.min(24 * 60, dryRunMinutesRaw))
    : 10;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const pausedUntil =
    stage === "paused" ? new Date(now + pausedMinutes * 60 * 1000).toISOString() : null;
  const dryRunUntil =
    stage === "dry_run" ? new Date(now + dryRunMinutes * 60 * 1000).toISOString() : null;

  if (!orgId) {
    return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const payload = {
    org_id: orgId,
    job_name: jobName,
    consecutive_failures: consecutiveFailures,
    paused_until: pausedUntil,
    resume_stage: stage,
    dry_run_until: dryRunUntil,
    last_opened_at: stage === "active" ? null : nowIso,
    manual_cleared_at: null,
    last_error: (body?.lastError ?? "seeded_for_e2e").slice(0, 1000),
    last_failed_at: nowIso,
    updated_at: nowIso
  };

  let result = await admin
    .from("org_job_circuit_breakers")
    .upsert(payload, { onConflict: "org_id,job_name" })
    .select("id, org_id, job_name, resume_stage, paused_until, dry_run_until, consecutive_failures")
    .single();

  if (result.error && isMissingColumnError(result.error.message)) {
    result = await admin
      .from("org_job_circuit_breakers")
      .upsert(
        {
          org_id: orgId,
          job_name: jobName,
          consecutive_failures: consecutiveFailures,
          paused_until: pausedUntil,
          last_error: (body?.lastError ?? "seeded_for_e2e").slice(0, 1000),
          last_failed_at: nowIso,
          updated_at: nowIso
        },
        { onConflict: "org_id,job_name" }
      )
      .select("id, org_id, job_name, paused_until, consecutive_failures")
      .single();
  }

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    row: result.data
  });
}
