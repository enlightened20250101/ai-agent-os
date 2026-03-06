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

export async function GET(req: Request) {
  const context = await getOptionalOrgContext();
  if (!context) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const orgId = context.orgId;
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const supabase = await createClient();
  let query = supabase
    .from("ai_execution_logs")
    .select("id, triggered_by_user_id, session_scope, channel_id, intent_type, execution_status, execution_ref_type, execution_ref_id, source, summary_text, created_at, finished_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const header = [
    "id",
    "created_at",
    "finished_at",
    "source",
    "execution_status",
    "session_scope",
    "channel_id",
    "triggered_by_user_id",
    "intent_type",
    "summary_text",
    "execution_ref_type",
    "execution_ref_id"
  ];

  const lines = [header.join(",")];
  for (const row of data ?? []) {
    lines.push(
      [
        row.id,
        row.created_at,
        row.finished_at,
        row.source,
        row.execution_status,
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
