import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function isEnabled() {
  return process.env.NODE_ENV === "test" || process.env.E2E_MODE === "1";
}

type SeedBody = {
  orgId?: string;
  taskId?: string | null;
  kind?: "failed_action" | "failed_workflow" | "stale_approval" | "policy_block";
  refId?: string;
  overdueHours?: number;
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
  const taskId = body?.taskId?.trim() || null;
  const kind = body?.kind ?? "failed_action";
  const refId = body?.refId?.trim() || `e2e-seeded-${Date.now()}`;
  const overdueHoursRaw = Number(body?.overdueHours ?? 10);
  const overdueHours = Number.isFinite(overdueHoursRaw) ? Math.max(1, Math.min(24 * 14, overdueHoursRaw)) : 10;

  if (!orgId) {
    return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  }

  const now = Date.now();
  const dueAt = new Date(now - overdueHours * 60 * 60 * 1000).toISOString();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("exception_cases")
    .upsert(
      {
        org_id: orgId,
        kind,
        ref_id: refId,
        task_id: taskId,
        status: "open",
        owner_user_id: null,
        note: "seeded for e2e",
        due_at: dueAt,
        updated_at: new Date(now).toISOString()
      },
      { onConflict: "org_id,kind,ref_id" }
    )
    .select("id, org_id, kind, ref_id, due_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, row: data });
}
