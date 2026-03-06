import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function isEnabled() {
  return process.env.NODE_ENV === "test" || process.env.E2E_MODE === "1";
}

type SeedBody = {
  orgId?: string;
  intentType?: string;
  recoveryPath?: string;
  includeChatAudit?: boolean;
  chatCommandStatus?: "pending" | "running" | "done" | "failed" | "cancelled";
  executionLogStatus?: "pending" | "running" | "done" | "failed" | "cancelled" | "declined" | "skipped";
  blockedByIncident?: boolean;
  incidentSeverity?: "low" | "medium" | "high";
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
  if (!orgId) {
    return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  }

  const intentType = body?.intentType?.trim() || "run_planner";
  const recoveryPath = body?.recoveryPath?.trim() || "/app/planner";
  const includeChatAudit = body?.includeChatAudit === true;
  const chatCommandStatus = body?.chatCommandStatus ?? "failed";
  const executionLogStatus = body?.executionLogStatus ?? "failed";
  const blockedByIncident = body?.blockedByIncident === true;
  const incidentSeverity = body?.incidentSeverity ?? "high";
  if (!recoveryPath.startsWith("/app/")) {
    return NextResponse.json({ error: "recoveryPath must start with /app/" }, { status: 400 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  let seededChatCommandId: string | null = null;
  let seededChatSessionId: string | null = null;

  const { data: plannerRun, error: plannerRunError } = await admin
    .from("planner_runs")
    .insert({
      org_id: orgId,
      status: "failed",
      started_at: nowIso,
      finished_at: nowIso,
      summary_json: {
        seeded_for_e2e: true,
        reason: "recovery_link_validation"
      },
      created_at: nowIso
    })
    .select("id, created_at")
    .single();
  if (plannerRunError) {
    return NextResponse.json({ error: plannerRunError.message }, { status: 500 });
  }

  if (includeChatAudit) {
    let sessionId: string | null = null;
    const { data: sharedSession, error: sharedSessionError } = await admin
      .from("chat_sessions")
      .select("id")
      .eq("org_id", orgId)
      .eq("scope", "shared")
      .limit(1)
      .maybeSingle();
    if (sharedSessionError) {
      return NextResponse.json({ error: sharedSessionError.message }, { status: 500 });
    }
    if (sharedSession?.id) {
      sessionId = String(sharedSession.id);
    } else {
      const { data: insertedSession, error: insertedSessionError } = await admin
        .from("chat_sessions")
        .insert({
          org_id: orgId,
          scope: "shared",
          owner_user_id: null,
          title: "general",
          created_at: nowIso,
          updated_at: nowIso
        })
        .select("id")
        .single();
      if (insertedSessionError) {
        return NextResponse.json({ error: insertedSessionError.message }, { status: 500 });
      }
      sessionId = String(insertedSession.id);
    }
    seededChatSessionId = sessionId;

    const { data: message, error: messageError } = await admin
      .from("chat_messages")
      .insert({
        org_id: orgId,
        session_id: sessionId,
        sender_type: "user",
        sender_user_id: null,
        body_text: "E2E seeded chat audit recovery request",
        metadata_json: {
          ai_mentioned: true,
          mentions: ["@AI"]
        },
        created_at: nowIso
      })
      .select("id")
      .single();
    if (messageError) {
      return NextResponse.json({ error: messageError.message }, { status: 500 });
    }

    const { data: intent, error: intentError } = await admin
      .from("chat_intents")
      .insert({
        org_id: orgId,
        message_id: message.id,
        intent_type: intentType,
        confidence: 0.99,
        intent_json: {
          summary: "E2E seeded chat audit recovery command"
        },
        created_at: nowIso
      })
      .select("id")
      .single();
    if (intentError) {
      return NextResponse.json({ error: intentError.message }, { status: 500 });
    }

    const { data: command, error: commandError } = await admin
      .from("chat_commands")
      .insert({
        org_id: orgId,
        session_id: sessionId,
        intent_id: intent.id,
        execution_status: chatCommandStatus,
        result_json: {
          recovery_path: recoveryPath
        },
        created_at: nowIso,
        finished_at: nowIso
      })
      .select("id")
      .single();
    if (commandError) {
      return NextResponse.json({ error: commandError.message }, { status: 500 });
    }
    seededChatCommandId = String(command.id);
  }

  const { data: executionLog, error: executionError } = await admin
    .from("ai_execution_logs")
      .insert({
        org_id: orgId,
      execution_status: executionLogStatus,
      source: "chat",
      intent_type: intentType,
      summary_text: "E2E seeded recovery log",
      session_id: seededChatSessionId,
      session_scope: seededChatSessionId ? "shared" : null,
      metadata_json: {
        seeded_for_e2e: true,
        recovery_path: recoveryPath,
        command_id: seededChatCommandId,
        blocked_by_incident: blockedByIncident,
        incident_severity: blockedByIncident ? incidentSeverity : null
      },
      created_at: nowIso,
      finished_at: nowIso
    })
    .select("id, created_at")
    .single();
  if (executionError) {
    return NextResponse.json({ error: executionError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    plannerRunId: plannerRun.id,
    executionLogId: executionLog.id,
    chatCommandId: seededChatCommandId,
    chatSessionId: seededChatSessionId,
    refTs: nowIso
  });
}
