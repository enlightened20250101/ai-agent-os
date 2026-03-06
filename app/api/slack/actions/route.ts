import { NextResponse } from "next/server";
import { resolveSlackRuntimeConfig } from "@/lib/connectors/runtime";
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
  const rawBody = await request.text();
  const formData = new URLSearchParams(rawBody);
  const payloadRaw = formData.get("payload");
  if (!payloadRaw) {
    return textResponse("payload がありません。", 400);
  }

  let payload: SlackActionPayload;
  try {
    payload = JSON.parse(payloadRaw) as SlackActionPayload;
  } catch {
    return textResponse("payload が不正です。", 400);
  }

  const actionValue = payload.actions?.[0]?.value;
  if (!actionValue) {
    return textResponse("action value がありません。", 400);
  }

  const approvalId = actionValue.split(":")[0];
  if (!approvalId) {
    return textResponse("action token が不正です。", 400);
  }

  const admin = createAdminClient();
  const { data: approval, error: approvalLookupError } = await admin
    .from("approvals")
    .select("id, org_id")
    .eq("id", approvalId)
    .maybeSingle();
  if (approvalLookupError || !approval) {
    return textResponse("承認対象が見つかりません。", 400);
  }

  const orgId = approval.org_id as string;
  const cfg = await resolveSlackRuntimeConfig({ supabase: admin, orgId });
  if (!cfg.signingSecret) {
    return textResponse("Slack連携が設定されていません。", 400);
  }

  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const isValid = verifySlackSignature({
    signingSecret: cfg.signingSecret,
    timestamp,
    signature,
    rawBody
  });
  if (!isValid) {
    return textResponse("署名が不正です。", 401);
  }

  const verifiedToken = verifyApprovalActionToken({
    signingSecret: cfg.signingSecret,
    token: actionValue
  });
  if (!verifiedToken) {
    return textResponse("action token が不正です。", 400);
  }

  try {
    const result = await decideApprovalShared({
      supabase: admin,
      approvalId: verifiedToken.approvalId,
      decision: verifiedToken.decision,
      actorType: "system",
      actorId: null,
      source: "slack",
      slackUserId: payload.user?.id ?? null
    });

    const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
    const taskUrl = `${appBaseUrl}/app/tasks/${result.taskId}`;
    const verb =
      result.approvalStatus === "approved"
        ? result.taskStatus === "ready_for_approval"
          ? "一次承認を記録しました（追加承認待ち）"
          : "最終承認を完了しました"
        : "却下しました";

    return NextResponse.json({
      response_type: "ephemeral",
      text: `${verb}。タスク: ${taskUrl}`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明な承認エラーです。";
    console.error(`[SLACK_ACTION_ERROR] ${message}`);
    return NextResponse.json(
      {
        response_type: "ephemeral",
        text: `アクション処理に失敗しました: ${message}`
      },
      { status: 400 }
    );
  }
}
