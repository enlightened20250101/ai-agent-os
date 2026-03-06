"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function buildOrgName(userEmail?: string) {
  if (!userEmail) {
    return "My Organization";
  }

  const prefix = userEmail.split("@")[0]?.trim();
  if (!prefix) {
    return "My Organization";
  }

  return `${prefix}'s Organization`;
}

function toOnboardingError(message: string) {
  return `/app/onboarding?error=${encodeURIComponent(message)}`;
}

export async function completeOnboarding(formData: FormData) {
  const userClient = await createClient();
  const {
    data: { user }
  } = await userClient.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const admin = createAdminClient();
  const workspaceNameRaw = String(formData.get("workspace_name") ?? "").trim();
  const inviteToken = String(formData.get("invite_token") ?? "").trim();
  const { data: existingMemberships, error: membershipLookupError } = await admin
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .limit(1);

  if (membershipLookupError) {
    throw new Error(`Onboarding failed while checking memberships: ${membershipLookupError.message}`);
  }

  if ((existingMemberships?.length ?? 0) === 0) {
    if (inviteToken) {
      const { data: invite, error: inviteError } = await admin
        .from("org_invite_links")
        .select("id, org_id, expires_at, revoked_at, used_count, max_uses")
        .eq("token", inviteToken)
        .maybeSingle();
      if (inviteError) {
        throw new Error(`Onboarding failed while loading invite: ${inviteError.message}`);
      }
      if (!invite) {
        redirect(toOnboardingError("招待リンクが見つかりません。"));
      }
      if (invite.revoked_at) {
        redirect(toOnboardingError("この招待リンクは無効化されています。"));
      }
      if (new Date(invite.expires_at as string).getTime() < Date.now()) {
        redirect(toOnboardingError("この招待リンクは期限切れです。"));
      }
      const usedCount = Number(invite.used_count ?? 0);
      const maxUses = Number(invite.max_uses ?? 0);
      if (maxUses > 0 && usedCount >= maxUses) {
        redirect(toOnboardingError("この招待リンクは利用上限に達しています。"));
      }

      const { error: createMembershipError } = await admin.from("memberships").insert({
        org_id: invite.org_id,
        user_id: user.id,
        role: "member"
      });
      if (createMembershipError && !createMembershipError.message.toLowerCase().includes("duplicate")) {
        throw new Error(
          `Onboarding failed while creating invited membership: ${createMembershipError.message}`
        );
      }

      const { error: inviteUpdateError } = await admin
        .from("org_invite_links")
        .update({ used_count: usedCount + 1 })
        .eq("id", invite.id);
      if (inviteUpdateError) {
        throw new Error(`Onboarding failed while updating invite usage: ${inviteUpdateError.message}`);
      }

      redirect("/app?ok=招待リンクからワークスペースに参加しました。");
    }

    const { data: createdOrg, error: createOrgError } = await admin
      .from("orgs")
      .insert({ name: workspaceNameRaw || buildOrgName(user.email) })
      .select("id")
      .single();

    if (createOrgError) {
      throw new Error(`Onboarding failed while creating org: ${createOrgError.message}`);
    }

    const { error: createMembershipError } = await admin.from("memberships").insert({
      org_id: createdOrg.id,
      user_id: user.id,
      role: "owner"
    });

    if (createMembershipError) {
      throw new Error(
        `Onboarding failed while creating initial membership: ${createMembershipError.message}`
      );
    }
  }

  redirect("/app");
}
