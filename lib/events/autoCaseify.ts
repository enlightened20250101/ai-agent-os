import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCaseTitleFromExternalEvent, inferCaseTypeFromExternalEvent } from "@/lib/events/caseify";

type AutoCaseifyArgs = {
  supabase: SupabaseClient;
  orgId: string;
  actorUserId?: string | null;
  limit?: number;
};

export type AutoCaseifyResult = {
  orgId: string;
  scanned: number;
  created: number;
  skipped: number;
  failed: number;
};

async function resolveActorUserId(args: { supabase: SupabaseClient; orgId: string; actorUserId?: string | null }) {
  if (args.actorUserId) return args.actorUserId;
  const membershipRes = await args.supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", args.orgId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membershipRes.error) {
    throw new Error(`Failed to resolve actor user for org ${args.orgId}: ${membershipRes.error.message}`);
  }
  return (membershipRes.data?.user_id as string | null | undefined) ?? null;
}

export async function runAutoCaseifyForOrg(args: AutoCaseifyArgs): Promise<AutoCaseifyResult> {
  const limit = Math.max(1, Math.min(200, args.limit ?? 30));
  const actorUserId = await resolveActorUserId(args);
  if (!actorUserId) {
    return { orgId: args.orgId, scanned: 0, created: 0, skipped: 0, failed: 0 };
  }

  const eventsRes = await args.supabase
    .from("external_events")
    .select("id, provider, event_type, summary_text, priority, status, linked_case_id, created_at")
    .eq("org_id", args.orgId)
    .eq("status", "new")
    .in("priority", ["urgent", "high"])
    .is("linked_case_id", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (eventsRes.error) {
    throw new Error(`Failed to load external events for auto caseify: ${eventsRes.error.message}`);
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const rows = eventsRes.data ?? [];
  for (const row of rows) {
    const provider = (row.provider as string | null) ?? "external";
    const eventType = (row.event_type as string | null) ?? "EVENT";
    const summary = (row.summary_text as string | null) ?? "";
    const caseType = inferCaseTypeFromExternalEvent({ provider, eventType, summary });
    const title = buildCaseTitleFromExternalEvent({ provider, eventType, summary });

    const caseRes = await args.supabase
      .from("business_cases")
      .insert({
        org_id: args.orgId,
        created_by_user_id: actorUserId,
        case_type: caseType,
        title,
        status: "open",
        stage: "intake",
        source: "external_event_auto"
      })
      .select("id")
      .single();
    if (caseRes.error) {
      failed += 1;
      continue;
    }
    const caseId = caseRes.data?.id as string | undefined;
    if (!caseId) {
      failed += 1;
      continue;
    }

    const updateRes = await args.supabase
      .from("external_events")
      .update({
        linked_case_id: caseId,
        status: "processed",
        processed_at: new Date().toISOString()
      })
      .eq("org_id", args.orgId)
      .eq("id", row.id as string)
      .is("linked_case_id", null);
    if (updateRes.error) {
      failed += 1;
      continue;
    }

    await args.supabase.from("case_events").insert({
      org_id: args.orgId,
      case_id: caseId,
      actor_user_id: actorUserId,
      event_type: "CASE_CREATED_FROM_EXTERNAL_EVENT",
      payload_json: {
        external_event_id: row.id,
        provider,
        event_type: eventType,
        summary,
        auto_caseify: true
      }
    });
    created += 1;
  }

  const scanned = rows.length;
  skipped = Math.max(0, scanned - created - failed);
  return {
    orgId: args.orgId,
    scanned,
    created,
    skipped,
    failed
  };
}
