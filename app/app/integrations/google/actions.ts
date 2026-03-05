"use server";

import { redirect } from "next/navigation";
import { upsertConnectorAccount } from "@/lib/connectors/getConnectorAccount";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

function withMessage(type: "ok" | "error", message: string) {
  return `/app/integrations/google?${type}=${encodeURIComponent(message)}`;
}

export async function saveGoogleConnector(formData: FormData) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const clientId = String(formData.get("client_id") ?? "").trim();
  const clientSecret = String(formData.get("client_secret") ?? "").trim();
  const refreshToken = String(formData.get("refresh_token") ?? "").trim();
  const senderEmail = String(formData.get("sender_email") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();

  if (!clientId || !clientSecret || !refreshToken || !senderEmail) {
    redirect(withMessage("error", "client_id, client_secret, refresh_token, sender_email are required."));
  }

  try {
    await upsertConnectorAccount({
      supabase,
      orgId,
      provider: "google",
      externalAccountId: senderEmail,
      displayName: displayName || null,
      secrets: {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        sender_email: senderEmail
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save Google connector.";
    redirect(withMessage("error", message));
  }

  redirect(withMessage("ok", "Google connector saved."));
}
