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

function getStaleHours() {
  const staleHoursRaw = Number.parseInt(process.env.APPROVAL_REMINDER_STALE_HOURS ?? "", 10);
  const fallbackStaleRaw = Number.parseInt(process.env.EXCEPTION_PENDING_APPROVAL_HOURS ?? "6", 10);
  const staleHours = Number.isNaN(staleHoursRaw)
    ? Number.isNaN(fallbackStaleRaw)
      ? 6
      : fallbackStaleRaw
    : staleHoursRaw;
  return Math.max(1, Math.min(24 * 14, staleHours));
}

function parseGuardThreshold(url: URL) {
  const raw = url.searchParams.get("min_stale");
  const queryValue = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isNaN(queryValue)) {
    return Math.max(1, Math.min(1000, queryValue));
  }
  const envValue = Number.parseInt(process.env.APPROVAL_REMINDER_AUTO_MIN_STALE ?? "3", 10);
  if (Number.isNaN(envValue)) return 3;
  return Math.max(1, Math.min(1000, envValue));
}

async function countStalePendingApprovals(args: {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  staleCutoffIso: string;
}) {
  const { admin, orgId, staleCutoffIso } = args;
  const countRes = await admin
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "pending")
    .lt("created_at", staleCutoffIso);
  if (countRes.error) {
    throw new Error(`stale approval count failed: ${countRes.error.message}`);
  }
  return countRes.count ?? 0;
}

export async function POST(request: Request) {
  if (!isAllowedByMode(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const orgId = url.searchParams.get("org_id")?.trim();
  const maxOrgsRaw = Number.parseInt(url.searchParams.get("max_orgs") ?? "20", 10);
  const maxOrgs = Number.isNaN(maxOrgsRaw) ? 20 : Math.max(1, Math.min(200, maxOrgsRaw));
  const guardThreshold = parseGuardThreshold(url);
  const staleHours = getStaleHours();
  const staleCutoffIso = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
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
      stale_pending_count?: number;
      threshold?: number;
      skipped_threshold?: boolean;
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
      try {
        const stalePendingCount = await countStalePendingApprovals({
          admin,
          orgId: targetOrgId,
          staleCutoffIso
        });
        if (stalePendingCount < guardThreshold) {
          results.push({
            org_id: targetOrgId,
            ok: true,
            stale_pending_count: stalePendingCount,
            threshold: guardThreshold,
            skipped_threshold: true,
            sent: false,
            reason: "below_threshold",
            target_count: 0,
            sent_count: 0
          });
          continue;
        }

        const retried = await runWithOpsRetry({
          supabase: admin,
          orgId: targetOrgId,
          jobName: "approval_reminders_auto_batch",
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
            stale_pending_count: stalePendingCount,
            threshold: guardThreshold,
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
            stale_pending_count: stalePendingCount,
            threshold: guardThreshold,
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
            stale_pending_count: stalePendingCount,
            threshold: guardThreshold,
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
            stale_pending_count: stalePendingCount,
            threshold: guardThreshold,
            error: retried.error
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown auto reminder error";
        results.push({
          org_id: targetOrgId,
          ok: false,
          threshold: guardThreshold,
          error: message
        });
      }
    }

    return NextResponse.json({
      ok: true,
      mode: "all_orgs",
      stale_hours: staleHours,
      threshold: guardThreshold,
      target_count: targets.length,
      success_count: results.filter((item) => item.ok).length,
      failure_count: results.filter((item) => !item.ok).length,
      sent_count: results.reduce((sum, item) => sum + (item.sent_count ?? 0), 0),
      skipped_threshold_count: results.filter((item) => item.skipped_threshold === true).length,
      results
    });
  }

  try {
    const stalePendingCount = await countStalePendingApprovals({ admin, orgId, staleCutoffIso });
    if (stalePendingCount < guardThreshold) {
      return NextResponse.json({
        ok: true,
        org_id: orgId,
        stale_hours: staleHours,
        threshold: guardThreshold,
        stale_pending_count: stalePendingCount,
        skipped_threshold: true,
        sent: false,
        reason: "below_threshold"
      });
    }

    const retried = await runWithOpsRetry({
      supabase: admin,
      orgId,
      jobName: "approval_reminders_auto_single",
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
        stale_hours: staleHours,
        threshold: guardThreshold,
        stale_pending_count: stalePendingCount,
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
        stale_hours: staleHours,
        threshold: guardThreshold,
        stale_pending_count: stalePendingCount,
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
        stale_hours: staleHours,
        threshold: guardThreshold,
        stale_pending_count: stalePendingCount,
        sent: false,
        reason: "dry_run_probe",
        target_count: 0,
        skipped_dry_run: true,
        paused_until: retried.pausedUntil
      });
    }
    return NextResponse.json({ error: retried.error }, { status: 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "auto reminder failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

