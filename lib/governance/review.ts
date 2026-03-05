import type { SupabaseClient } from "@supabase/supabase-js";
import { buildGovernanceRecommendations } from "@/lib/governance/recommendations";

type RecommendationReviewResult = {
  orgId: string;
  ok: boolean;
  criticalCount?: number;
  highCount?: number;
  recommendationCount?: number;
  error?: string;
};

export async function getOrCreateGovernanceOpsTaskId(args: { supabase: SupabaseClient; orgId: string }) {
  const { supabase, orgId } = args;
  const title = "__SYSTEM_GOVERNANCE_EVENTS__";
  const { data: existing, error: existingError } = await supabase
    .from("tasks")
    .select("id")
    .eq("org_id", orgId)
    .eq("title", title)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw new Error(`governance ops task lookup failed: ${existingError.message}`);
  }
  if (existing?.id) {
    return existing.id as string;
  }

  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membershipError) {
    throw new Error(`membership lookup failed: ${membershipError.message}`);
  }
  const fallbackUserId = (membership?.user_id as string | undefined) ?? null;
  if (!fallbackUserId) {
    throw new Error("no membership user found to create governance ops task");
  }

  const { data: created, error: createError } = await supabase
    .from("tasks")
    .insert({
      org_id: orgId,
      created_by_user_id: fallbackUserId,
      title,
      input_text: "Internal task for governance recommendation review events.",
      status: "done"
    })
    .select("id")
    .single();
  if (createError) {
    throw new Error(`governance ops task create failed: ${createError.message}`);
  }
  return created.id as string;
}

export async function runGovernanceRecommendationReview(args: {
  supabase: SupabaseClient;
  orgId: string;
}): Promise<RecommendationReviewResult> {
  const { supabase, orgId } = args;
  try {
    const { summary, recommendations } = await buildGovernanceRecommendations({ supabase, orgId });
    const taskId = await getOrCreateGovernanceOpsTaskId({ supabase, orgId });

    const criticalCount = recommendations.filter((item) => item.priority === "critical").length;
    const highCount = recommendations.filter((item) => item.priority === "high").length;

    const { error: eventError } = await supabase.from("task_events").insert({
      org_id: orgId,
      task_id: taskId,
      actor_type: "system",
      actor_id: null,
      event_type: "GOVERNANCE_RECOMMENDATIONS_REVIEWED",
      payload_json: {
        summary,
        recommendation_count: recommendations.length,
        critical_count: criticalCount,
        high_count: highCount,
        top_recommendations: recommendations.slice(0, 5).map((item) => ({
          id: item.id,
          priority: item.priority,
          title: item.title,
          metric_label: item.metricLabel,
          metric_value: item.metricValue
        }))
      }
    });
    if (eventError) {
      throw new Error(`review event insert failed: ${eventError.message}`);
    }

    return {
      orgId,
      ok: true,
      criticalCount,
      highCount,
      recommendationCount: recommendations.length
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    try {
      const taskId = await getOrCreateGovernanceOpsTaskId({ supabase, orgId });
      await supabase.from("task_events").insert({
        org_id: orgId,
        task_id: taskId,
        actor_type: "system",
        actor_id: null,
        event_type: "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED",
        payload_json: {
          error: message
        }
      });
    } catch (logError) {
      const logMessage = logError instanceof Error ? logError.message : "unknown logging error";
      console.error(`[GOV_REVIEW_FAIL_LOG_ERROR] org_id=${orgId} ${logMessage}`);
    }
    return { orgId, ok: false, error: message };
  }
}
