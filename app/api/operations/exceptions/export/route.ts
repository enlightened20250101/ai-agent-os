import { NextResponse } from "next/server";
import { getOptionalOrgContext } from "@/lib/org/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type ExceptionCaseRow = {
  id: string;
  kind: string;
  ref_id: string;
  task_id: string | null;
  status: "open" | "in_progress" | "resolved";
  owner_user_id: string | null;
  note: string;
  due_at: string | null;
  last_alerted_at: string | null;
  updated_at: string;
};

type TaskLite = {
  id: string;
  title: string;
  status: string;
};

type ExceptionCaseEventLite = {
  exception_case_id: string;
  event_type: string;
  created_at: string;
  payload_json: unknown;
};

function csvEscape(value: unknown) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function isMissingTable(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = request.headers.get("x-export-token");
  const exportToken = process.env.EXCEPTION_EXPORT_TOKEN;
  const orgIdFromQuery = url.searchParams.get("org_id")?.trim() ?? "";

  let orgId = "";
  let userId = "";
  let supabase = await createClient();
  if (exportToken && token && token === exportToken) {
    if (!orgIdFromQuery) {
      return NextResponse.json({ error: "org_id_required_for_token_mode" }, { status: 400 });
    }
    orgId = orgIdFromQuery;
    userId = "system:exception_export";
    supabase = createAdminClient();
  } else {
    const orgContext = await getOptionalOrgContext();
    if (!orgContext) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    orgId = orgContext.orgId;
    userId = orgContext.userId;
  }

  const selectedView = String(url.searchParams.get("view") ?? "all");
  const requestedOwner = String(url.searchParams.get("owner") ?? "all");
  const requestedCaseStatus = String(url.searchParams.get("case_status") ?? "all");
  const requestedOverdueOnly = String(url.searchParams.get("overdue_only") ?? "") === "1";
  const selectedSort = String(url.searchParams.get("sort") ?? "priority_desc");
  const format = String(url.searchParams.get("format") ?? "csv").toLowerCase();
  const includePayload = String(url.searchParams.get("include_payload") ?? "1") !== "0";
  const limitRaw = Number.parseInt(String(url.searchParams.get("limit") ?? "5000"), 10);
  const offsetRaw = Number.parseInt(String(url.searchParams.get("offset") ?? "0"), 10);
  const limit = Number.isNaN(limitRaw) ? 5000 : Math.max(1, Math.min(10000, limitRaw));
  const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

  const selectedOwner =
    selectedView === "my_open"
      ? userId
      : selectedView === "overdue_unassigned"
        ? "unassigned"
        : requestedOwner;
  const selectedCaseStatus =
    selectedView === "my_open" ? "open" : selectedView === "overdue_unassigned" ? "all" : requestedCaseStatus;
  const overdueOnly = selectedView === "overdue_unassigned" ? true : requestedOverdueOnly;

  const { data: cases, error: casesError } = await supabase
    .from("exception_cases")
    .select("id, kind, ref_id, task_id, status, owner_user_id, note, due_at, last_alerted_at, updated_at")
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(5000);

  if (casesError) {
    if (isMissingTable(casesError.message, "exception_cases")) {
      return NextResponse.json({ error: "exception_cases_missing" }, { status: 400 });
    }
    return NextResponse.json({ error: casesError.message }, { status: 500 });
  }

  const rows = (cases ?? []) as ExceptionCaseRow[];

  const filtered = rows.filter((row) => {
    if (selectedCaseStatus !== "all" && row.status !== selectedCaseStatus) return false;
    if (selectedOwner === "unassigned" && row.owner_user_id) return false;
    if (selectedOwner !== "all" && selectedOwner !== "unassigned" && row.owner_user_id !== selectedOwner) {
      return false;
    }
    if (overdueOnly) {
      if (!row.due_at || row.status === "resolved") return false;
      const dueMs = new Date(row.due_at).getTime();
      if (!Number.isFinite(dueMs) || dueMs >= Date.now()) return false;
    }
    return true;
  });

  const taskIds = Array.from(new Set(filtered.map((row) => row.task_id).filter((v): v is string => Boolean(v))));
  const taskMap = new Map<string, TaskLite>();
  if (taskIds.length > 0) {
    const { data: tasks } = await supabase
      .from("tasks")
      .select("id, title, status")
      .eq("org_id", orgId)
      .in("id", taskIds);
    for (const t of tasks ?? []) {
      taskMap.set(t.id as string, {
        id: t.id as string,
        title: t.title as string,
        status: t.status as string
      });
    }
  }

  const withPriority = filtered.map((row) => {
    const task = row.task_id ? taskMap.get(row.task_id) : null;
    const dueTs = row.due_at ? new Date(row.due_at).getTime() : Number.POSITIVE_INFINITY;
    const updatedTs = new Date(row.updated_at).getTime();
    const overdueHours =
      row.due_at && row.status !== "resolved"
        ? Math.max(0, Math.floor((Date.now() - new Date(row.due_at).getTime()) / (60 * 60 * 1000)))
        : 0;
    const statusWeight = row.status === "open" ? 25 : row.status === "in_progress" ? 15 : 5;
    const ownerWeight = row.owner_user_id ? 0 : 15;
    const score = Math.min(100, statusWeight + ownerWeight + Math.min(60, overdueHours));
    return {
      row,
      task,
      dueTs: Number.isFinite(dueTs) ? dueTs : Number.POSITIVE_INFINITY,
      updatedTs: Number.isFinite(updatedTs) ? updatedTs : 0,
      overdueHours,
      score
    };
  });

  const sorted = [...withPriority].sort((a, b) => {
    if (selectedSort === "due_asc") {
      const d = a.dueTs - b.dueTs;
      if (d !== 0) return d;
      return b.score - a.score;
    }
    if (selectedSort === "updated_desc") {
      const d = b.updatedTs - a.updatedTs;
      if (d !== 0) return d;
      return b.score - a.score;
    }
    return b.score - a.score;
  });
  const totalCount = sorted.length;
  const paged = sorted.slice(offset, offset + limit);

  const caseIds = paged.map((item) => item.row.id);
  const eventSummary = new Map<
    string,
    {
      count: number;
      latestType: string | null;
      latestAt: string | null;
      latestPayload: unknown;
    }
  >();
  if (caseIds.length > 0) {
    const { data: events, error: eventsError } = await supabase
      .from("exception_case_events")
      .select("exception_case_id, event_type, created_at, payload_json")
      .eq("org_id", orgId)
      .in("exception_case_id", caseIds)
      .order("created_at", { ascending: false })
      .limit(10000);
    if (eventsError && !isMissingTable(eventsError.message, "exception_case_events")) {
      return NextResponse.json({ error: eventsError.message }, { status: 500 });
    }
    for (const raw of (events ?? []) as ExceptionCaseEventLite[]) {
      const id = raw.exception_case_id;
      const current = eventSummary.get(id) ?? {
        count: 0,
        latestType: null,
        latestAt: null,
        latestPayload: null
      };
      current.count += 1;
      if (!current.latestAt) {
        current.latestAt = raw.created_at;
        current.latestType = raw.event_type;
        current.latestPayload = raw.payload_json;
      }
      eventSummary.set(id, current);
    }
  }

  const header = [
    "id",
    "kind",
    "ref_id",
    "status",
    "owner_user_id",
    "due_at",
    "overdue_hours",
    "score",
    "task_id",
    "task_title",
    "task_status",
    "exception_event_count",
    "latest_exception_event_type",
    "latest_exception_event_at",
    "latest_exception_event_payload_json",
    "note",
    "last_alerted_at",
    "updated_at"
  ];

  const exportedAt = new Date().toISOString();
  const hasMore = offset + limit < totalCount;
  const nextOffset = hasMore ? offset + limit : null;
  const exportMeta = {
    exported_at: exportedAt,
    org_id: orgId,
    exported_by_user_id: userId,
    filter_owner: selectedOwner,
    filter_case_status: selectedCaseStatus,
    filter_overdue_only: overdueOnly,
    filter_view: selectedView,
    filter_sort: selectedSort,
    filter_include_payload: includePayload,
    filter_limit: limit,
    filter_offset: offset,
    row_count_total: totalCount,
    row_count_exported: paged.length,
    has_more: hasMore,
    next_offset: nextOffset
  };

  if (format === "json") {
    return NextResponse.json({
      meta: exportMeta,
      rows: paged.map((item) => {
        const summary = eventSummary.get(item.row.id) ?? {
          count: 0,
          latestType: null,
          latestAt: null,
          latestPayload: null
        };
        return {
          id: item.row.id,
          kind: item.row.kind,
          ref_id: item.row.ref_id,
          status: item.row.status,
          owner_user_id: item.row.owner_user_id,
          due_at: item.row.due_at,
          overdue_hours: item.overdueHours,
          score: item.score,
          task_id: item.row.task_id,
          task_title: item.task?.title ?? null,
          task_status: item.task?.status ?? null,
          exception_event_count: summary.count,
          latest_exception_event_type: summary.latestType,
          latest_exception_event_at: summary.latestAt,
          latest_exception_event_payload_json: includePayload ? summary.latestPayload : null,
          note: item.row.note,
          last_alerted_at: item.row.last_alerted_at,
          updated_at: item.row.updated_at
        };
      })
    });
  }

  const metaLines = [
    `# exported_at,${csvEscape(exportMeta.exported_at)}`,
    `# org_id,${csvEscape(exportMeta.org_id)}`,
    `# exported_by_user_id,${csvEscape(exportMeta.exported_by_user_id)}`,
    `# filter_owner,${csvEscape(exportMeta.filter_owner)}`,
    `# filter_case_status,${csvEscape(exportMeta.filter_case_status)}`,
    `# filter_overdue_only,${csvEscape(String(exportMeta.filter_overdue_only))}`,
    `# filter_view,${csvEscape(exportMeta.filter_view)}`,
    `# filter_sort,${csvEscape(exportMeta.filter_sort)}`,
    `# filter_include_payload,${csvEscape(String(exportMeta.filter_include_payload))}`,
    `# filter_limit,${csvEscape(String(exportMeta.filter_limit))}`,
    `# filter_offset,${csvEscape(String(exportMeta.filter_offset))}`,
    `# row_count_total,${csvEscape(String(exportMeta.row_count_total))}`,
    `# row_count_exported,${csvEscape(String(exportMeta.row_count_exported))}`,
    `# has_more,${csvEscape(String(exportMeta.has_more))}`,
    `# next_offset,${csvEscape(String(exportMeta.next_offset ?? ""))}`
  ];

  const lines = [...metaLines, header.join(",")];
  for (const item of paged) {
    const summary = eventSummary.get(item.row.id) ?? {
      count: 0,
      latestType: null,
      latestAt: null,
      latestPayload: null
    };
    lines.push(
      [
        item.row.id,
        item.row.kind,
        item.row.ref_id,
        item.row.status,
        item.row.owner_user_id ?? "",
        item.row.due_at ?? "",
        item.overdueHours,
        item.score,
        item.row.task_id ?? "",
        item.task?.title ?? "",
        item.task?.status ?? "",
        summary.count,
        summary.latestType ?? "",
        summary.latestAt ?? "",
        includePayload && summary.latestPayload ? JSON.stringify(summary.latestPayload) : "",
        item.row.note ?? "",
        item.row.last_alerted_at ?? "",
        item.row.updated_at
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const filename = `exception-cases-${orgId}-${exportedAt.slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`
    }
  });
}
