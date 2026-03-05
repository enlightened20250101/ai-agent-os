import { NextResponse } from "next/server";
import { decideApprovalShared } from "@/lib/approvals/decide";
import { verifyApprovalActionToken } from "@/lib/slack/actionToken";
import { verifySlackSignature } from "@/lib/slack/signature";
import { createAdminClient } from "@/lib/supabase/admin";

function textResponse(message: string, status = 200) {
  return new NextResponse(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}

type SlackActionPayload = {
  user?: { id?: string };
  actions?: Array<{ value?: string }>;
};

export async function POST(request: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return textResponse("Slack integration is not configured.", 400);
  }

  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const isValid = verifySlackSignature({
    signingSecret,
    timestamp,
    signature,
    rawBody
  });
  if (!isValid) {
    return textResponse("Invalid signature.", 401);
  }

  const formData = new URLSearchParams(rawBody);
  const payloadRaw = formData.get("payload");
  if (!payloadRaw) {
    return textResponse("Missing payload.", 400);
  }

  let payload: SlackActionPayload;
  try {
    payload = JSON.parse(payloadRaw) as SlackActionPayload;
  } catch {
    return textResponse("Invalid payload.", 400);
  }

  const actionValue = payload.actions?.[0]?.value;
  if (!actionValue) {
    return textResponse("Missing action value.", 400);
  }

  const tokenPayload = verifyApprovalActionToken({
    signingSecret,
    token: actionValue
  });
  if (!tokenPayload) {
    return textResponse("Invalid action token.", 400);
  }

  const admin = createAdminClient();
  try {
    const result = await decideApprovalShared({
      supabase: admin,
      approvalId: tokenPayload.approvalId,
      decision: tokenPayload.decision,
      actorType: "system",
      actorId: null,
      source: "slack",
      slackUserId: payload.user?.id ?? null
    });

    const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
    const taskUrl = `${appBaseUrl}/app/tasks/${result.taskId}`;
    const verb = result.approvalStatus === "approved" ? "Approved" : "Rejected";

    return NextResponse.json({
      response_type: "ephemeral",
      text: `${verb}. View task: ${taskUrl}`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown approval error.";
    console.error(`[SLACK_ACTION_ERROR] ${message}`);
    return NextResponse.json(
      {
        response_type: "ephemeral",
        text: `Failed to process action: ${message}`
      },
      { status: 400 }
    );
  }
}
