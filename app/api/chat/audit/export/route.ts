import { NextResponse } from "next/server";
import { getOptionalOrgContext } from "@/lib/org/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type ChatCommandRow = {
  id: string;
  session_id: string;
  intent_id: string;
  execution_status: string;
  execution_ref_type: string | null;
  execution_ref_id: string | null;
  result_json: unknown;
  created_at: string;
  finished_at: string | null;
};

function csvEscape(value: unknown) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = request.headers.get("x-export-token");
  const exportToken = process.env.CHAT_EXPORT_TOKEN;
  const orgIdFromQuery = url.searchParams.get("org_id")?.trim() ?? "";

  let orgId = "";
  let userId = "";
  let supabase = await createClient();
  if (exportToken && token && token === exportToken) {
    if (!orgIdFromQuery) {
      return NextResponse.json({ error: "org_id_required_for_token_mode" }, { status: 400 });
    }
    orgId = orgIdFromQuery;
    userId = "system:chat_audit_export";
    supabase = createAdminClient();
  } else {
    const orgContext = await getOptionalOrgContext();
    if (!orgContext) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    orgId = orgContext.orgId;
    userId = orgContext.userId;
  }

  const statusFilter =
    url.searchParams.get("status") === "failed" ||
    url.searchParams.get("status") === "pending" ||
    url.searchParams.get("status") === "running" ||
    url.searchParams.get("status") === "done"
      ? (url.searchParams.get("status") as string)
      : "all";
  const scopeFilter = url.searchParams.get("scope") === "shared" || url.searchParams.get("scope") === "personal"
    ? (url.searchParams.get("scope") as string)
    : "all";
  const intentFilter = url.searchParams.get("intent")?.trim() || "all";
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  const limitRaw = Number.parseInt(String(url.searchParams.get("limit") ?? "5000"), 10);
  const offsetRaw = Number.parseInt(String(url.searchParams.get("offset") ?? "0"), 10);
  const includeResult = String(url.searchParams.get("include_result") ?? "1") !== "0";
  const limit = Number.isNaN(limitRaw) ? 5000 : Math.max(1, Math.min(10000, limitRaw));
  const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

  let commandsQuery = supabase
    .from("chat_commands")
    .select("id, session_id, intent_id, execution_status, execution_ref_type, execution_ref_id, result_json, created_at, finished_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (statusFilter !== "all") {
    commandsQuery = commandsQuery.eq("execution_status", statusFilter);
  }
  const { data: commandsData, error: commandsError } = await commandsQuery;
  if (commandsError) {
    return NextResponse.json({ error: commandsError.message }, { status: 500 });
  }

  const commands = (commandsData ?? []) as ChatCommandRow[];
  const sessionIds = Array.from(new Set(commands.map((row) => row.session_id)));
  const intentIds = Array.from(new Set(commands.map((row) => row.intent_id)));

  const sessionMap = new Map<string, { scope: string; owner: string | null }>();
  if (sessionIds.length > 0) {
    const { data: sessionsData, error: sessionsError } = await supabase
      .from("chat_sessions")
      .select("id, scope, owner_user_id")
      .eq("org_id", orgId)
      .in("id", sessionIds);
    if (sessionsError) {
      return NextResponse.json({ error: sessionsError.message }, { status: 500 });
    }
    for (const row of sessionsData ?? []) {
      sessionMap.set(row.id as string, {
        scope: (row.scope as string) ?? "unknown",
        owner: (row.owner_user_id as string | null) ?? null
      });
    }
  }

  const intentMap = new Map<string, { intentType: string; summary: string | null }>();
  if (intentIds.length > 0) {
    const { data: intentsData, error: intentsError } = await supabase
      .from("chat_intents")
      .select("id, intent_type, intent_json")
      .eq("org_id", orgId)
      .in("id", intentIds);
    if (intentsError) {
      return NextResponse.json({ error: intentsError.message }, { status: 500 });
    }
    for (const row of intentsData ?? []) {
      const intentJson =
        typeof row.intent_json === "object" && row.intent_json !== null ? (row.intent_json as Record<string, unknown>) : {};
      intentMap.set(row.id as string, {
        intentType: (row.intent_type as string) ?? "unknown",
        summary: typeof intentJson.summary === "string" ? intentJson.summary : null
      });
    }
  }

  let filtered = commands.filter((row) => {
    if (scopeFilter !== "all" && sessionMap.get(row.session_id)?.scope !== scopeFilter) return false;
    if (intentFilter !== "all" && intentMap.get(row.intent_id)?.intentType !== intentFilter) return false;
    return true;
  });

  const totalCount = filtered.length;
  filtered = filtered.slice(offset, offset + limit);
  const hasMore = offset + limit < totalCount;
  const nextOffset = hasMore ? offset + limit : null;
  const exportedAt = new Date().toISOString();

  const rows = filtered.map((row) => {
    const session = sessionMap.get(row.session_id);
    const intent = intentMap.get(row.intent_id);
    const result =
      includeResult && row.result_json && typeof row.result_json === "object"
        ? JSON.stringify(row.result_json)
        : null;
    return {
      command_id: row.id,
      session_id: row.session_id,
      session_scope: session?.scope ?? "unknown",
      session_owner_user_id: session?.owner ?? null,
      intent_id: row.intent_id,
      intent_type: intent?.intentType ?? "unknown",
      intent_summary: intent?.summary ?? null,
      execution_status: row.execution_status,
      execution_ref_type: row.execution_ref_type,
      execution_ref_id: row.execution_ref_id,
      result_json: result,
      created_at: row.created_at,
      finished_at: row.finished_at
    };
  });

  const meta = {
    exported_at: exportedAt,
    org_id: orgId,
    exported_by_user_id: userId,
    filter_status: statusFilter,
    filter_scope: scopeFilter,
    filter_intent: intentFilter,
    filter_limit: limit,
    filter_offset: offset,
    filter_include_result: includeResult,
    row_count_total: totalCount,
    row_count_exported: rows.length,
    has_more: hasMore,
    next_offset: nextOffset
  };

  if (format === "json") {
    return NextResponse.json({ meta, rows });
  }

  const header = [
    "command_id",
    "session_id",
    "session_scope",
    "session_owner_user_id",
    "intent_id",
    "intent_type",
    "intent_summary",
    "execution_status",
    "execution_ref_type",
    "execution_ref_id",
    "result_json",
    "created_at",
    "finished_at"
  ];
  const metaLines = [
    `# exported_at,${csvEscape(meta.exported_at)}`,
    `# org_id,${csvEscape(meta.org_id)}`,
    `# exported_by_user_id,${csvEscape(meta.exported_by_user_id)}`,
    `# filter_status,${csvEscape(meta.filter_status)}`,
    `# filter_scope,${csvEscape(meta.filter_scope)}`,
    `# filter_intent,${csvEscape(meta.filter_intent)}`,
    `# filter_limit,${csvEscape(String(meta.filter_limit))}`,
    `# filter_offset,${csvEscape(String(meta.filter_offset))}`,
    `# filter_include_result,${csvEscape(String(meta.filter_include_result))}`,
    `# row_count_total,${csvEscape(String(meta.row_count_total))}`,
    `# row_count_exported,${csvEscape(String(meta.row_count_exported))}`,
    `# has_more,${csvEscape(String(meta.has_more))}`,
    `# next_offset,${csvEscape(String(meta.next_offset ?? ""))}`
  ];
  const lines = [...metaLines, header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.command_id,
        row.session_id,
        row.session_scope,
        row.session_owner_user_id ?? "",
        row.intent_id,
        row.intent_type,
        row.intent_summary ?? "",
        row.execution_status,
        row.execution_ref_type ?? "",
        row.execution_ref_id ?? "",
        row.result_json ?? "",
        row.created_at,
        row.finished_at ?? ""
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const filename = `chat-audit-${orgId}-${exportedAt.slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`
    }
  });
}
