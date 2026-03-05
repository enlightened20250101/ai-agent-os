import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function isCleanupEnabled() {
  return process.env.NODE_ENV === "test" || process.env.E2E_MODE === "1";
}

export async function POST(request: Request) {
  if (!isCleanupEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const expectedToken = process.env.E2E_CLEANUP_TOKEN;
  const providedToken = request.headers.get("x-e2e-cleanup-token");
  if (!expectedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { orgId?: string } | null;
  const orgId = body?.orgId;
  if (!orgId) {
    return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("orgs").delete().eq("id", orgId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
