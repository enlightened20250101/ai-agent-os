"use server";

import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(type: "ok" | "error", message: string) {
  return `/app/integrations/google?${type}=${encodeURIComponent(message)}`;
}

export async function disconnectGoogleConnector() {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const { error } = await supabase
    .from("connector_accounts")
    .delete()
    .eq("org_id", orgId)
    .eq("provider", "google");

  if (error) {
    redirect(withMessage("error", `Failed to disconnect Google connector: ${error.message}`));
  }

  redirect(withMessage("ok", "Google connector disconnected."));
}
