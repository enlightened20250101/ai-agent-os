import { NextResponse } from "next/server";
import { sendApprovalReminders } from "@/lib/approvals/reminders";
import { runWithOpsRetry } from "@/lib/governance/jobRetry";
import { createAdminClient } from "@/lib/supabase/admin";

function isAllowedByMode(request: Request) {
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  const expected =
    process.env.APPROVAL_REMINDER_TOKEN ??
    process.env.EXCEPTION_ALERTS_TOKEN ??
    process.env.INCIDENT_AUTOMATION_TOKEN ??
    process.env.GOV_RECOMMENDATIONS_TOKEN ??
    process.env.PLANNER_RUN_TOKEN;
  const received =
    request.headers.get("x-approval-token") ??
    request.headers.get("x-exception-token") ??
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
      sent?: boolean;
      reason?: string;
      target_count?: number;
      sent_count?: number;
      skipped_cooldown_count?: number;
      skipped_circuit?: boolean;
      skipped_dry_run?: boolean;
      paused_until?: string | null;
      error?: string;
    }> = [];

    for (const targetOrgId of targets) {
      const retried = await runWithOpsRetry({
        supabase: admin,
        orgId: targetOrgId,
        jobName: "approval_reminders_batch",
        run: async () =>
          sendApprovalReminders({
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
          sent: result.sent,
          reason: result.reason,
          target_count: result.targetCount,
          sent_count: result.sentCount,
          skipped_cooldown_count: result.skippedCooldownCount
        });
      } else if (retried.circuitOpen) {
        results.push({
          org_id: targetOrgId,
          ok: true,
          sent: false,
          reason: "circuit_open",
          target_count: 0,
          skipped_circuit: true,
          paused_until: retried.pausedUntil
        });
      } else if (retried.dryRunProbe) {
        results.push({
          org_id: targetOrgId,
          ok: true,
          sent: false,
          reason: "dry_run_probe",
          target_count: 0,
          skipped_dry_run: true,
          paused_until: retried.pausedUntil
        });
      } else {
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
      sent_count: results.reduce((sum, item) => sum + (item.sent_count ?? 0), 0),
      results
    });
  }

  const retried = await runWithOpsRetry({
    supabase: admin,
    orgId,
    jobName: "approval_reminders_single",
    run: async () =>
      sendApprovalReminders({
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
      sent: result.sent,
      reason: result.reason,
      target_count: result.targetCount,
      sent_count: result.sentCount,
      skipped_cooldown_count: result.skippedCooldownCount
    });
  }
  if (retried.circuitOpen) {
    return NextResponse.json({
      ok: true,
      org_id: orgId,
      sent: false,
      reason: "circuit_open",
      target_count: 0,
      skipped_circuit: true,
      paused_until: retried.pausedUntil
    });
  }
  if (retried.dryRunProbe) {
    return NextResponse.json({
      ok: true,
      org_id: orgId,
      sent: false,
      reason: "dry_run_probe",
      target_count: 0,
      skipped_dry_run: true,
      paused_until: retried.pausedUntil
    });
  }
  return NextResponse.json({ error: retried.error }, { status: 500 });
}
