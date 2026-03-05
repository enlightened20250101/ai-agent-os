import { NextResponse } from "next/server";
import { evaluateGovernance } from "@/lib/governance/evaluate";
import { createClient } from "@/lib/supabase/server";

function isMissingTableError(message: string, tableName: string) {
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }
  if (!membership?.org_id) {
    return NextResponse.json({ error: "No org membership" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data = body as Record<string, unknown>;
  const provider = data.provider;
  const actionType = data.action_type;
  const to = data.to;
  const subject = data.subject;
  const bodyText = data.body_text;
  const policyStatus = data.policy_status;

  if (
    provider !== "google" ||
    actionType !== "send_email" ||
    typeof to !== "string" ||
    typeof subject !== "string" ||
    typeof bodyText !== "string" ||
    (policyStatus !== "pass" && policyStatus !== "warn" && policyStatus !== "block")
  ) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  try {
    const result = await evaluateGovernance({
      supabase,
      orgId: membership.org_id as string,
      taskId: typeof data.task_id === "string" ? data.task_id : null,
      proposalId: typeof data.proposal_id === "string" ? data.proposal_id : null,
      provider,
      actionType,
      to,
      subject,
      bodyText,
      policyStatus,
      agentRoleKey: typeof data.agent_role_key === "string" ? data.agent_role_key : null
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Governance evaluation failed";
    if (
      isMissingTableError(message, "org_autonomy_settings") ||
      isMissingTableError(message, "risk_assessments") ||
      isMissingTableError(message, "trust_scores") ||
      isMissingTableError(message, "budget_limits") ||
      isMissingTableError(message, "budget_usage")
    ) {
      return NextResponse.json(
        {
          error: "governance tables are not ready. run supabase migrations first"
        },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
