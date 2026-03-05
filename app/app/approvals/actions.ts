"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { decideApprovalShared } from "@/lib/approvals/decide";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function errorRedirect(message: string) {
  return `/app/approvals?error=${encodeURIComponent(message)}`;
}

export async function decideApproval(formData: FormData) {
  const approvalId = String(formData.get("approval_id") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!approvalId || (decision !== "approved" && decision !== "rejected")) {
    redirect(errorRedirect("Invalid approval decision request."));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  let result;
  try {
    result = await decideApprovalShared({
      supabase,
      approvalId,
      decision,
      reason,
      actorType: "user",
      actorId: userId,
      source: "web",
      expectedOrgId: orgId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval decision failed.";
    redirect(errorRedirect(message));
  }

  revalidatePath("/app/approvals");
  revalidatePath("/app/tasks");
  revalidatePath(`/app/tasks/${result.taskId}`);
}
