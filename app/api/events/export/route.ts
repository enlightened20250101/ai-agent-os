import { NextResponse } from "next/server";
import { getOptionalOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export async function GET(request: Request) {
  const context = await getOptionalOrgContext();
  if (!context) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const provider = url.searchParams.get("provider");
  const source = url.searchParams.get("source");
  const priority = url.searchParams.get("priority");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const keyword = url.searchParams.get("q")?.trim() ?? "";

  const supabase = await createClient();
  let query = supabase
    .from("external_events")
    .select("id, provider, source, event_type, external_event_id, summary_text, status, occurred_at, processed_at, created_at")
    .eq("org_id", context.orgId)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (status && status !== "all") query = query.eq("status", status);
  if (provider && provider !== "all") query = query.eq("provider", provider);
  if (source && source !== "all") query = query.eq("source", source);
  if (priority && priority !== "all") query = query.eq("priority", priority);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []).filter((row) => {
    if (!keyword) return true;
    const haystack = `${row.event_type ?? ""} ${row.summary_text ?? ""} ${row.external_event_id ?? ""}`.toLowerCase();
    return haystack.includes(keyword.toLowerCase());
  });

  const header = [
    "id",
    "created_at",
    "occurred_at",
    "provider",
    "source",
    "status",
    "priority",
    "event_type",
    "external_event_id",
    "summary_text",
    "processed_at"
  ];
  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.created_at,
        row.occurred_at,
        row.provider,
        row.source,
        row.status,
        (row as { priority?: string | null }).priority ?? "normal",
        row.event_type,
        row.external_event_id,
        row.summary_text,
        row.processed_at
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename=external-events-${context.orgId}.csv`
    }
  });
}
