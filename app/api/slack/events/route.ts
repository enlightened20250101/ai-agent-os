import { NextResponse } from "next/server";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
import { appendTaskEvent } from "@/lib/events/taskEvents";
import { verifySlackSignature } from "@/lib/slack/signature";
import { createAdminClient } from "@/lib/supabase/admin";

type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  team?: { id?: string };
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    text?: string;
    user?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
  };
};

function json(data: Record<string, unknown>, status = 200) {
  return NextResponse.json(data, { status });
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: string }).code === "23505";
}

function isMissingTableError(message: string, tableName: string) {
  return message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`);
}

function normalizeText(raw: string) {
  return raw
    .replace(/<@[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTaskTitle(text: string) {
  const normalized = normalizeText(text);
  const fallback = "Slackからの取り込みタスク";
  if (!normalized) return fallback;
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

async function resolveSlackContext(args: { teamId: string | null }) {
  const admin = createAdminClient();
  if (args.teamId) {
    const { data: connector } = await admin
      .from("connector_accounts")
      .select("org_id, secrets_json")
      .eq("provider", "slack")
      .eq("external_account_id", args.teamId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (connector) {
      const secrets = (connector.secrets_json ?? {}) as Record<string, unknown>;
      const signingSecret = typeof secrets.signing_secret === "string" ? secrets.signing_secret : "";
      if (signingSecret) {
        return {
          orgId: connector.org_id as string,
          signingSecret
        };
      }
    }
  }

  const envSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const envOrgId = process.env.SLACK_DEFAULT_ORG_ID ?? "";
  if (envSecret) {
    return {
      orgId: envOrgId || null,
      signingSecret: envSecret
    };
  }

  return null;
}

async function resolveDefaultUserId(admin: ReturnType<typeof createAdminClient>, orgId: string) {
  const { data: membership, error } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`membership lookup failed: ${error.message}`);
  if (!membership?.user_id) throw new Error("org membership not found");
  return membership.user_id as string;
}

async function resolveDefaultAgentId(admin: ReturnType<typeof createAdminClient>, orgId: string) {
  const preferred = await admin
    .from("agents")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .eq("role_key", "accounting")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (preferred.error) throw new Error(`agent lookup failed: ${preferred.error.message}`);
  if (preferred.data?.id) return preferred.data.id as string;

  const firstActive = await admin
    .from("agents")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (firstActive.error) throw new Error(`fallback agent lookup failed: ${firstActive.error.message}`);
  return (firstActive.data?.id as string | undefined) ?? null;
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  let body: SlackEventEnvelope;
  try {
    body = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const teamId =
    (typeof body.team_id === "string" ? body.team_id : null) ??
    (typeof body.team?.id === "string" ? body.team.id : null);

  const ctx = await resolveSlackContext({ teamId });
  if (!ctx) {
    return json({ error: "slack_not_configured" }, 400);
  }

  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const validSignature = verifySlackSignature({
    signingSecret: ctx.signingSecret,
    timestamp,
    signature,
    rawBody
  });
  if (!validSignature) {
    return json({ error: "invalid_signature" }, 401);
  }

  if (body.type === "url_verification") {
    return json({ challenge: body.challenge ?? "" });
  }

  if (body.type !== "event_callback") {
    return json({ ok: true, ignored: "unsupported_event_envelope" });
  }

  if (!ctx.orgId) {
    return json({ error: "org_resolution_failed" }, 400);
  }

  const event = body.event;
  const eventId = typeof body.event_id === "string" ? body.event_id : "";
  if (!event || !eventId) {
    return json({ error: "missing_event_payload" }, 400);
  }

  if (event.subtype === "bot_message" || event.bot_id) {
    return json({ ok: true, ignored: "bot_event" });
  }

  const isIntakeEvent = event.type === "app_mention" || event.type === "message";
  if (!isIntakeEvent) {
    return json({ ok: true, ignored: "event_type_not_supported" });
  }

  const admin = createAdminClient();
  const runtimeCfg = await resolveSlackRuntimeConfig({ supabase: admin, orgId: ctx.orgId });
  const targetChannel = runtimeCfg.intakeChannelId || runtimeCfg.approvalChannelId;
  if (targetChannel && targetChannel !== event.channel) {
    return json({ ok: true, ignored: "channel_not_configured_for_intake" });
  }

  const { error: receiptError } = await admin.from("slack_event_receipts").insert({
    org_id: ctx.orgId,
    event_id: eventId,
    event_type: event.type ?? "unknown",
    payload_json: {
      team_id: teamId,
      channel: event.channel ?? null,
      user: event.user ?? null,
      ts: event.ts ?? null
    }
  });

  if (receiptError) {
    if (isUniqueViolation(receiptError)) {
      return json({ ok: true, ignored: "duplicate_event" });
    }
    if (!isMissingTableError(receiptError.message, "slack_event_receipts")) {
      return json({ error: `receipt_insert_failed:${receiptError.message}` }, 500);
    }
  }

  const text = typeof event.text === "string" ? event.text : "";
  const userId = await resolveDefaultUserId(admin, ctx.orgId);
  const agentId = await resolveDefaultAgentId(admin, ctx.orgId);

  const { data: createdTask, error: taskError } = await admin
    .from("tasks")
    .insert({
      org_id: ctx.orgId,
      created_by_user_id: userId,
      agent_id: agentId,
      title: buildTaskTitle(text),
      input_text:
        `source=slack\n` +
        `team_id=${teamId ?? ""}\n` +
        `channel=${event.channel ?? ""}\n` +
        `slack_user_id=${event.user ?? ""}\n` +
        `slack_ts=${event.ts ?? ""}\n\n` +
        text,
      status: "draft"
    })
    .select("id, title, status")
    .single();

  if (taskError) {
    return json({ error: `task_create_failed:${taskError.message}` }, 500);
  }

  const taskId = createdTask.id as string;

  await appendTaskEvent({
    supabase: admin,
    orgId: ctx.orgId,
    taskId,
    actorType: "system",
    actorId: null,
    eventType: "TASK_CREATED",
    payload: {
      changed_fields: {
        title: createdTask.title,
        status: createdTask.status,
        source: "slack_intake"
      },
      slack: {
        event_id: eventId,
        team_id: teamId,
        channel: event.channel ?? null,
        user: event.user ?? null,
        ts: event.ts ?? null
      }
    }
  });

  await appendTaskEvent({
    supabase: admin,
    orgId: ctx.orgId,
    taskId,
    actorType: "system",
    actorId: null,
    eventType: "SLACK_TASK_INTAKE",
    payload: {
      event_id: eventId,
      team_id: teamId,
      channel: event.channel ?? null,
      slack_user_id: event.user ?? null,
      text_excerpt: text.slice(0, 500)
    }
  });

  return json({ ok: true, task_id: taskId });
}
