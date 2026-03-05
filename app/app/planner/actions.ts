"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runPlanner } from "@/lib/planner/runPlanner";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(type: "ok" | "error", message: string) {
  return `/app/planner?${type}=${encodeURIComponent(message)}`;
}

export async function runPlannerNow() {
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  let created = 0;
  try {
    const result = await runPlanner({
      supabase,
      orgId,
      actorUserId: userId,
      maxProposals: 3
    });
    created = result.createdProposals;
  } catch (error) {
    const message = error instanceof Error ? error.message : "プランナー実行に失敗しました。";
    redirect(withMessage("error", message));
  }

  revalidatePath("/app/planner");
  revalidatePath("/app/proposals");
  redirect(withMessage("ok", `プランナー実行が完了しました。${created} 件の提案を作成しました。`));
}
