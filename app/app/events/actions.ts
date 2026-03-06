"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveSafeAppReturnTo, withMessageOnReturnTo } from "@/lib/app/returnTo";
import { appendCaseEventSafe } from "@/lib/cases/events";
import { runAutoCaseifyForOrg } from "@/lib/events/autoCaseify";
import { buildCaseTitleFromExternalEvent, inferCaseTypeFromExternalEvent } from "@/lib/events/caseify";
import { triageExternalEvent } from "@/lib/events/triage";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

type EventFilters = {
  status: string;
  provider: string;
  source: string;
  priority: string;
  from: string;
  to: string;
  q: string;
};

function eventsPathWithFilters(filters: EventFilters) {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.provider && filters.provider !== "all") params.set("provider", filters.provider);
  if (filters.source && filters.source !== "all") params.set("source", filters.source);
  if (filters.priority && filters.priority !== "all") params.set("priority", filters.priority);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.q) params.set("q", filters.q);
  const qs = params.toString();
  return qs.length > 0 ? `/app/events?${qs}` : "/app/events";
}

function withMessage(kind: "ok" | "error", message: string, filters: EventFilters, returnTo?: string) {
  const target = resolveSafeAppReturnTo(returnTo, eventsPathWithFilters(filters));
  return withMessageOnReturnTo({ returnTo: target, kind, message });
}

export async function updateExternalEventStatus(formData: FormData) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const eventId = String(formData.get("event_id") ?? "").trim();
  const statusRaw = String(formData.get("to_status") ?? "").trim();
  const filters: EventFilters = {
    status: String(formData.get("status") ?? "all").trim() || "all",
    provider: String(formData.get("provider") ?? "all").trim() || "all",
    source: String(formData.get("source") ?? "all").trim() || "all",
    priority: String(formData.get("priority") ?? "all").trim() || "all",
    from: String(formData.get("from") ?? "").trim(),
    to: String(formData.get("to") ?? "").trim(),
    q: String(formData.get("q") ?? "").trim()
  };
  const returnTo = String(formData.get("return_to") ?? "").trim();
  const nextStatus =
    statusRaw === "new" || statusRaw === "processed" || statusRaw === "ignored" || statusRaw === "failed"
      ? statusRaw
      : null;

  if (!eventId || !nextStatus) {
    redirect(withMessage("error", "event_id または status が不正です。", filters, returnTo));
  }

  const payload: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "processed") {
    payload.processed_at = new Date().toISOString();
  }
  const { error } = await supabase.from("external_events").update(payload).eq("org_id", orgId).eq("id", eventId);
  if (error) {
    redirect(withMessage("error", `更新失敗: ${error.message}`, filters, returnTo));
  }

  revalidatePath("/app/events");
  revalidatePath("/app/monitor");
  redirect(withMessage("ok", "外部イベント状態を更新しました。", filters, returnTo));
}

export async function runExternalEventAutoTriage(formData: FormData) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const filters: EventFilters = {
    status: String(formData.get("status") ?? "all").trim() || "all",
    provider: String(formData.get("provider") ?? "all").trim() || "all",
    source: String(formData.get("source") ?? "all").trim() || "all",
    priority: String(formData.get("priority") ?? "all").trim() || "all",
    from: String(formData.get("from") ?? "").trim(),
    to: String(formData.get("to") ?? "").trim(),
    q: String(formData.get("q") ?? "").trim()
  };
  const returnTo = String(formData.get("return_to") ?? "").trim();

  const { data, error } = await supabase
    .from("external_events")
    .select("id, provider, event_type, summary_text, created_at")
    .eq("org_id", orgId)
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) {
    redirect(withMessage("error", `自動仕分け対象の取得に失敗: ${error.message}`, filters, returnTo));
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    redirect(withMessage("ok", "未処理イベントがないため仕分け対象はありません。", filters, returnTo));
  }

  let updated = 0;
  for (const row of rows) {
    const triage = triageExternalEvent({
      provider: (row.provider as string | null) ?? null,
      eventType: (row.event_type as string | null) ?? null,
      summaryText: (row.summary_text as string | null) ?? null,
      createdAt: (row.created_at as string | null) ?? null
    });
    const { error: updateError } = await supabase
      .from("external_events")
      .update({
        priority: triage.priority,
        triage_note: triage.triageNote,
        triaged_at: new Date().toISOString()
      })
      .eq("org_id", orgId)
      .eq("id", row.id as string);
    if (!updateError) {
      updated += 1;
    }
  }

  revalidatePath("/app/events");
  revalidatePath("/app/monitor");
  redirect(withMessage("ok", `自動仕分けを実行しました（更新 ${updated} 件）。`, filters, returnTo));
}

export async function createCaseFromExternalEvent(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const eventId = String(formData.get("event_id") ?? "").trim();
  const filters: EventFilters = {
    status: String(formData.get("status") ?? "all").trim() || "all",
    provider: String(formData.get("provider") ?? "all").trim() || "all",
    source: String(formData.get("source") ?? "all").trim() || "all",
    priority: String(formData.get("priority") ?? "all").trim() || "all",
    from: String(formData.get("from") ?? "").trim(),
    to: String(formData.get("to") ?? "").trim(),
    q: String(formData.get("q") ?? "").trim()
  };
  const returnTo = String(formData.get("return_to") ?? "").trim();
  if (!eventId) {
    redirect(withMessage("error", "event_id が不正です。", filters, returnTo));
  }

  const { data: eventRow, error: eventError } = await supabase
    .from("external_events")
    .select("id, provider, event_type, summary_text, status, linked_case_id")
    .eq("org_id", orgId)
    .eq("id", eventId)
    .maybeSingle();
  if (eventError) {
    redirect(withMessage("error", `外部イベントの取得に失敗: ${eventError.message}`, filters, returnTo));
  }
  if (!eventRow) {
    redirect(withMessage("error", "対象イベントが見つかりません。", filters, returnTo));
  }

  const existingCaseId = (eventRow.linked_case_id as string | null) ?? null;
  if (existingCaseId) {
    redirect(withMessage("ok", "既にCase化されています。", filters, returnTo));
  }

  const provider = (eventRow.provider as string | null) ?? "external";
  const eventType = (eventRow.event_type as string | null) ?? "EVENT";
  const summary = (eventRow.summary_text as string | null) ?? "";
  const caseType = inferCaseTypeFromExternalEvent({ provider, eventType, summary });

  const { data: createdCase, error: caseError } = await supabase
    .from("business_cases")
    .insert({
      org_id: orgId,
      created_by_user_id: userId,
      case_type: caseType,
      title: buildCaseTitleFromExternalEvent({ provider, eventType, summary }),
      status: "open",
      stage: "intake",
      source: "external_event"
    })
    .select("id")
    .single();
  if (caseError) {
    redirect(withMessage("error", `Case作成に失敗: ${caseError.message}`, filters, returnTo));
  }
  const caseId = (createdCase?.id as string | undefined) ?? "";
  if (!caseId) {
    redirect(withMessage("error", "Case作成結果が不正です。", filters, returnTo));
  }

  const { error: eventUpdateError } = await supabase
    .from("external_events")
    .update({
      linked_case_id: caseId,
      status: "processed",
      processed_at: new Date().toISOString()
    })
    .eq("org_id", orgId)
    .eq("id", eventId);
  if (eventUpdateError) {
    redirect(withMessage("error", `イベント更新に失敗: ${eventUpdateError.message}`, filters, returnTo));
  }

  await appendCaseEventSafe({
    supabase,
    orgId,
    caseId,
    actorUserId: userId,
    eventType: "CASE_CREATED_FROM_EXTERNAL_EVENT",
    payload: {
      external_event_id: eventId,
      provider,
      event_type: eventType,
      summary
    }
  });

  revalidatePath("/app/events");
  revalidatePath("/app/cases");
  revalidatePath(`/app/cases/${caseId}`);
  redirect(withMessage("ok", "外部イベントからCaseを起票しました。", filters, returnTo));
}

export async function runHighPriorityAutoCaseify(formData: FormData) {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();
  const filters: EventFilters = {
    status: String(formData.get("status") ?? "all").trim() || "all",
    provider: String(formData.get("provider") ?? "all").trim() || "all",
    source: String(formData.get("source") ?? "all").trim() || "all",
    priority: String(formData.get("priority") ?? "all").trim() || "all",
    from: String(formData.get("from") ?? "").trim(),
    to: String(formData.get("to") ?? "").trim(),
    q: String(formData.get("q") ?? "").trim()
  };
  const returnTo = String(formData.get("return_to") ?? "").trim();
  let result;
  try {
    result = await runAutoCaseifyForOrg({
      supabase,
      orgId,
      actorUserId: userId,
      limit: 50
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "高優先度Case化に失敗しました。";
    redirect(withMessage("error", message, filters, returnTo));
  }

  revalidatePath("/app/events");
  revalidatePath("/app/cases");
  redirect(
    withMessage(
      "ok",
      `高優先度イベントを自動Case化しました。created=${result.created}, scanned=${result.scanned}, failed=${result.failed}`,
      filters,
      returnTo
    )
  );
}
