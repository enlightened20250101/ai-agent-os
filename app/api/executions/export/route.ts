import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getOptionalOrgContext } from "@/lib/org/context";

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export async function GET(req: Request) {
  const context = await getOptionalOrgContext();
  if (!context) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const orgId = context.orgId;
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const source = url.searchParams.get("source");
  const status = url.searchParams.get("status");
  const requester = url.searchParams.get("requester");
  const scope = url.searchParams.get("scope");
  const intent = url.searchParams.get("intent");
  const channel = url.searchParams.get("channel");
  const incident = url.searchParams.get("incident");
  const sessionId = url.searchParams.get("session_id");

  const supabase = await createClient();
  let query = supabase
    .from("ai_execution_logs")
    .select("id, triggered_by_user_id, session_id, session_scope, channel_id, intent_type, execution_status, execution_ref_type, execution_ref_id, source, summary_text, created_at, finished_at, metadata_json")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  if (source && source !== "all") query = query.eq("source", source);
  if (status && status !== "all") query = query.eq("execution_status", status);
  if (requester && requester !== "all") query = query.eq("triggered_by_user_id", requester);
  if (scope && scope !== "all") query = query.eq("session_scope", scope);
  if (intent && intent !== "all") query = query.eq("intent_type", intent);
  if (channel && channel !== "all") query = query.eq("channel_id", channel);
  if (sessionId && sessionId.trim().length > 0) query = query.eq("session_id", sessionId.trim());

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows =
    incident === "blocked"
      ? (data ?? []).filter((row) => {
          const meta = asObject(row.metadata_json);
          return meta?.blocked_by_incident === true;
        })
      : (data ?? []);

  const header = [
    "id",
    "created_at",
    "finished_at",
    "source",
    "execution_status",
    "session_id",
    "session_scope",
    "channel_id",
    "triggered_by_user_id",
    "intent_type",
    "summary_text",
    "execution_ref_type",
    "execution_ref_id"
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.created_at,
        row.finished_at,
        row.source,
        row.execution_status,
        row.session_id,
        row.session_scope,
        row.channel_id,
        row.triggered_by_user_id,
        row.intent_type,
        row.summary_text,
        row.execution_ref_type,
        row.execution_ref_id
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename=ai-executions-${orgId}.csv`
    }
  });
}
