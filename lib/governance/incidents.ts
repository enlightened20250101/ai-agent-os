import type { SupabaseClient } from "@supabase/supabase-js";

export type OrgIncident = {
  id: string;
  org_id: string;
  status: "open" | "resolved";
  severity: "info" | "warning" | "critical";
  reason: string;
  metadata_json: Record<string, unknown>;
  opened_by: string | null;
  opened_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

function isMissingIncidentTable(message: string) {
  return (
    message.includes('relation "org_incidents" does not exist') ||
    message.includes("Could not find the table 'public.org_incidents'")
  );
}

export async function listOpenIncidents(args: { supabase: SupabaseClient; orgId: string }) {
  const { data, error } = await args.supabase
    .from("org_incidents")
    .select(
      "id, org_id, status, severity, reason, metadata_json, opened_by, opened_at, resolved_by, resolved_at, created_at, updated_at"
    )
    .eq("org_id", args.orgId)
    .eq("status", "open")
    .order("opened_at", { ascending: false });

  if (error) {
    if (isMissingIncidentTable(error.message)) {
      return [] as OrgIncident[];
    }
    throw new Error(`incident query failed: ${error.message}`);
  }

  return (data ?? []) as OrgIncident[];
}

export async function getLatestOpenIncident(args: { supabase: SupabaseClient; orgId: string }) {
  const incidents = await listOpenIncidents(args);
  return incidents[0] ?? null;
}

