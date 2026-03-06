import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function isAuthorized(request: Request) {
  if (process.env.NODE_ENV === "development") return true;
  const expected = process.env.EVENTS_INGEST_TOKEN;
  const received = request.headers.get("x-events-token");
  return Boolean(expected && received && expected === received);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseProvider(value: unknown) {
  if (value === "google") return "gmail";
  if (value === "gmail" || value === "slack" || value === "system" || value === "webhook") return value;
  return null;
}

function parseSource(value: unknown) {
  if (value === "api" || value === "slack" || value === "gmail" || value === "system" || value === "webhook") return value;
  return "api";
}

function isDuplicateError(message: string) {
  return message.includes("duplicate key value violates unique constraint");
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const row = asObject(body);
  if (!row) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgId = typeof row.org_id === "string" && row.org_id.trim().length > 0 ? row.org_id.trim() : null;
  const provider = parseProvider(row.provider);
  const eventType = typeof row.event_type === "string" && row.event_type.trim().length > 0 ? row.event_type.trim() : null;
  const externalEventId =
    typeof row.external_event_id === "string" && row.external_event_id.trim().length > 0
      ? row.external_event_id.trim()
      : null;
  const summaryText =
    typeof row.summary_text === "string" && row.summary_text.trim().length > 0 ? row.summary_text.trim() : null;
  const payloadJson = asObject(row.payload_json) ?? {};
  const source = parseSource(row.source);
  const occurredAt =
    typeof row.occurred_at === "string" && row.occurred_at.trim().length > 0 ? row.occurred_at.trim() : new Date().toISOString();

  if (!orgId || !provider || !eventType) {
    return NextResponse.json(
      { error: "Missing required fields: org_id, provider(gmail|slack|system|webhook), event_type" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  if (externalEventId) {
    const { data: existing } = await admin
      .from("external_events")
      .select("id")
      .eq("org_id", orgId)
      .eq("provider", provider)
      .eq("external_event_id", externalEventId)
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      return NextResponse.json({ ok: true, duplicate: true, id: existing.id });
    }
  }

  const { data, error } = await admin
    .from("external_events")
    .insert({
      org_id: orgId,
      provider,
      event_type: eventType,
      external_event_id: externalEventId,
      summary_text: summaryText,
      payload_json: payloadJson,
      status: "new",
      source,
      occurred_at: occurredAt
    })
    .select("id")
    .single();

  if (error) {
    if (externalEventId && isDuplicateError(error.message)) {
      const { data: existing } = await admin
        .from("external_events")
        .select("id")
        .eq("org_id", orgId)
        .eq("provider", provider)
        .eq("external_event_id", externalEventId)
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        return NextResponse.json({ ok: true, duplicate: true, id: existing.id });
      }
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, duplicate: false, id: data.id });
}
