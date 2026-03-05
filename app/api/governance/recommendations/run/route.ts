import { NextResponse } from "next/server";
import { evaluateAndMaybeOpenIncident } from "@/lib/governance/incidentAuto";
import { runWithOpsRetry } from "@/lib/governance/jobRetry";
import { maybeSendOpsFailureAlert } from "@/lib/governance/opsAlerts";
import { runGovernanceRecommendationReview } from "@/lib/governance/review";
import { createAdminClient } from "@/lib/supabase/admin";

function isAllowedByMode(request: Request) {
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  const expected = process.env.GOV_RECOMMENDATIONS_TOKEN ?? process.env.PLANNER_RUN_TOKEN;
  const received = request.headers.get("x-governance-token") ?? request.headers.get("x-planner-token");
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
      recommendation_count?: number;
      critical_count?: number;
      high_count?: number;
      skipped_circuit?: boolean;
      skipped_dry_run?: boolean;
      paused_until?: string | null;
      auto_incident_opened?: boolean;
      auto_incident_reason?: string;
      auto_incident_id?: string;
      alert_sent?: boolean;
      alert_reason?: string;
      alert_key?: string | null;
      error?: string;
    }> = [];

    for (const targetOrgId of targets) {
      const retried = await runWithOpsRetry({
        supabase: admin,
        orgId: targetOrgId,
        jobName: "governance_recommendations_batch",
        run: async () => {
          const result = await runGovernanceRecommendationReview({ supabase: admin, orgId: targetOrgId });
          const autoIncident = await evaluateAndMaybeOpenIncident({
            supabase: admin,
            orgId: targetOrgId,
            actorUserId: null,
            source: "review"
          });
          const alert = await maybeSendOpsFailureAlert({ supabase: admin, orgId: targetOrgId });
          return { result, autoIncident, alert };
        }
      });
      if (retried.ok) {
        const { result, autoIncident, alert } = retried.value;
        results.push({
          org_id: result.orgId,
          ok: result.ok,
          recommendation_count: result.recommendationCount,
          critical_count: result.criticalCount,
          high_count: result.highCount,
          auto_incident_opened: autoIncident.opened,
          auto_incident_reason: autoIncident.reason,
          auto_incident_id: autoIncident.incidentId,
          alert_sent: alert.sent,
          alert_reason: alert.reason,
          alert_key: alert.alertKey,
          error: result.error
        });
      } else {
        if (retried.circuitOpen) {
          results.push({
            org_id: targetOrgId,
            ok: true,
            skipped_circuit: true,
            paused_until: retried.pausedUntil
          });
          continue;
        }
        if (retried.dryRunProbe) {
          results.push({
            org_id: targetOrgId,
            ok: true,
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
    jobName: "governance_recommendations_single",
    run: async () => {
      const result = await runGovernanceRecommendationReview({ supabase: admin, orgId });
      const autoIncident = await evaluateAndMaybeOpenIncident({
        supabase: admin,
        orgId,
        actorUserId: null,
        source: "review"
      });
      const alert = await maybeSendOpsFailureAlert({ supabase: admin, orgId });
      return { result, autoIncident, alert };
    }
  });
  if (!retried.ok) {
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
  const { result, autoIncident, alert } = retried.value;
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error ?? "review failed",
        auto_incident_opened: autoIncident.opened,
        auto_incident_reason: autoIncident.reason,
        auto_incident_id: autoIncident.incidentId,
        alert_sent: alert.sent,
        alert_reason: alert.reason,
        alert_key: alert.alertKey
      },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    org_id: result.orgId,
    recommendation_count: result.recommendationCount,
    critical_count: result.criticalCount,
    high_count: result.highCount,
    auto_incident_opened: autoIncident.opened,
    auto_incident_reason: autoIncident.reason,
    auto_incident_id: autoIncident.incidentId,
    alert_sent: alert.sent,
    alert_reason: alert.reason,
    alert_key: alert.alertKey
  });
}
