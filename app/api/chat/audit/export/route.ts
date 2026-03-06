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
    url.searchParams.get("status") === "done" ||
    url.searchParams.get("status") === "declined" ||
    url.searchParams.get("status") === "skipped"
      ? (url.searchParams.get("status") as string)
      : "all";
  const scopeFilter =
    url.searchParams.get("scope") === "shared" ||
    url.searchParams.get("scope") === "personal" ||
    url.searchParams.get("scope") === "channel"
    ? (url.searchParams.get("scope") as string)
    : "all";
  const intentFilter = url.searchParams.get("intent")?.trim() || "all";
  const skipReasonFilter = url.searchParams.get("skip_reason")?.trim() || "all";
  const aiFilter = url.searchParams.get("ai") === "mentioned" || url.searchParams.get("ai") === "non_mentioned"
    ? (url.searchParams.get("ai") as string)
    : "all";
  const windowFilter = url.searchParams.get("window") === "24h" || url.searchParams.get("window") === "30d"
    ? (url.searchParams.get("window") as string)
    : "7d";
  const sessionIdFilter = url.searchParams.get("session_id")?.trim() ?? "";
  const windowHours = windowFilter === "24h" ? 24 : windowFilter === "30d" ? 30 * 24 : 7 * 24;
  const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
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
  if (sessionIdFilter.length > 0) {
    commandsQuery = commandsQuery.eq("session_id", sessionIdFilter);
  }
  commandsQuery = commandsQuery.gte("created_at", windowStartIso);
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

  const intentMap = new Map<string, { intentType: string; summary: string | null; messageId: string | null }>();
  if (intentIds.length > 0) {
    const { data: intentsData, error: intentsError } = await supabase
      .from("chat_intents")
      .select("id, intent_type, intent_json, message_id")
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
        summary: typeof intentJson.summary === "string" ? intentJson.summary : null,
        messageId: (row.message_id as string | null) ?? null
      });
    }
  }

  const messageIds = Array.from(
    new Set(Array.from(intentMap.values()).map((row) => row.messageId).filter((v): v is string => Boolean(v)))
  );
  const messageMetaById = new Map<string, { aiMentioned: boolean; mentions: string[] }>();
  if (messageIds.length > 0) {
    const { data: messagesData, error: messagesError } = await supabase
      .from("chat_messages")
      .select("id, metadata_json")
      .eq("org_id", orgId)
      .in("id", messageIds);
    if (messagesError) {
      return NextResponse.json({ error: messagesError.message }, { status: 500 });
    }
    for (const row of messagesData ?? []) {
      const metadata =
        typeof row.metadata_json === "object" && row.metadata_json !== null
          ? (row.metadata_json as Record<string, unknown>)
          : null;
      const mentions = Array.isArray(metadata?.mentions)
        ? metadata.mentions.filter((item): item is string => typeof item === "string")
        : [];
      messageMetaById.set(row.id as string, {
        aiMentioned: metadata?.ai_mentioned === true,
        mentions
      });
    }
  }

  let filtered = commands.filter((row) => {
    if (scopeFilter !== "all" && sessionMap.get(row.session_id)?.scope !== scopeFilter) return false;
    if (intentFilter !== "all" && intentMap.get(row.intent_id)?.intentType !== intentFilter) return false;
    if (aiFilter !== "all") {
      const messageId = intentMap.get(row.intent_id)?.messageId ?? null;
      const aiMentioned = messageId ? (messageMetaById.get(messageId)?.aiMentioned ?? false) : false;
      if (aiFilter === "mentioned" && !aiMentioned) return false;
      if (aiFilter === "non_mentioned" && aiMentioned) return false;
    }
    if (skipReasonFilter !== "all") {
      const result =
        row.result_json && typeof row.result_json === "object" ? (row.result_json as Record<string, unknown>) : null;
      if (!result || result.skipped !== true) return false;
      if (result.skip_reason !== skipReasonFilter) return false;
    }
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
    const messageMeta = intent?.messageId ? messageMetaById.get(intent.messageId) : null;
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
      ai_mentioned: messageMeta?.aiMentioned ?? false,
      mention_tokens: messageMeta?.mentions.join("|") ?? "",
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
    filter_skip_reason: skipReasonFilter,
    filter_ai: aiFilter,
    filter_window: windowFilter,
    filter_session_id: sessionIdFilter || "all",
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
    "ai_mentioned",
    "mention_tokens",
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
    `# filter_skip_reason,${csvEscape(meta.filter_skip_reason)}`,
    `# filter_ai,${csvEscape(meta.filter_ai)}`,
    `# filter_window,${csvEscape(meta.filter_window)}`,
    `# filter_session_id,${csvEscape(meta.filter_session_id)}`,
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
        row.ai_mentioned ? "1" : "0",
        row.mention_tokens,
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

  const safeFilter = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "all";
  const filename = `chat-audit-${orgId}-${safeFilter(statusFilter)}-${safeFilter(scopeFilter)}-${safeFilter(intentFilter)}-${safeFilter(
    skipReasonFilter
  )}-${safeFilter(windowFilter)}-${exportedAt.slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`
    }
  });
}
