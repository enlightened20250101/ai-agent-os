import type { SupabaseClient } from "@supabase/supabase-js";

type TrustOutcome = "success" | "failed";

type RecordTrustOutcomeArgs = {
  supabase: SupabaseClient;
  orgId: string;
  provider: "google";
  actionType: "send_email";
  outcome: TrustOutcome;
  agentRoleKey?: string | null;
  taskId?: string | null;
  actionId?: string | null;
  source: "manual_action_runner" | "workflow_step" | "approval_rejection";
};

const DEFAULT_TRUST_SCORE = 60;
const DEFAULT_SAMPLE_SIZE = 0;

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function outcomeDelta(outcome: TrustOutcome, sampleSize: number) {
  const base = outcome === "success" ? 2 : -8;
  const multiplier = sampleSize >= 200 ? 0.25 : sampleSize >= 80 ? 0.5 : sampleSize >= 30 ? 0.75 : 1;
  return Math.round(base * multiplier);
}

function isMissingTrustTable(message: string) {
  return (
    message.includes('relation "trust_scores" does not exist') ||
    message.includes("Could not find the table 'public.trust_scores'")
  );
}

export async function recordTrustOutcome(args: RecordTrustOutcomeArgs) {
  const query = args.supabase
    .from("trust_scores")
    .select("score, sample_size")
    .eq("org_id", args.orgId)
    .eq("provider", args.provider)
    .eq("action_type", args.actionType)
    .order("updated_at", { ascending: false })
    .limit(1);

  const scopedQuery = args.agentRoleKey
    ? query.eq("agent_role_key", args.agentRoleKey)
    : query.is("agent_role_key", null);

  const { data: latest, error: latestError } = await scopedQuery.maybeSingle();
  if (latestError) {
    if (isMissingTrustTable(latestError.message)) {
      return;
    }
    throw new Error(`trust score lookup failed: ${latestError.message}`);
  }

  const previousScore = (latest?.score as number | undefined) ?? DEFAULT_TRUST_SCORE;
  const previousSample = (latest?.sample_size as number | undefined) ?? DEFAULT_SAMPLE_SIZE;
  const delta = outcomeDelta(args.outcome, previousSample);
  const nextScore = clampScore(previousScore + delta);

  const { error: insertError } = await args.supabase.from("trust_scores").insert({
    org_id: args.orgId,
    provider: args.provider,
    action_type: args.actionType,
    agent_role_key: args.agentRoleKey ?? null,
    score: nextScore,
    sample_size: previousSample + 1,
    metadata_json: {
      previous_score: previousScore,
      delta,
      outcome: args.outcome,
      task_id: args.taskId ?? null,
      action_id: args.actionId ?? null,
      source: args.source
    },
    updated_at: new Date().toISOString()
  });

  if (insertError) {
    if (isMissingTrustTable(insertError.message)) {
      return;
    }
    throw new Error(`trust score insert failed: ${insertError.message}`);
  }
}
