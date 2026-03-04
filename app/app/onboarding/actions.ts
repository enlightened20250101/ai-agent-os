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

export async function completeOnboarding() {
  const userClient = await createClient();
  const {
    data: { user }
  } = await userClient.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const admin = createAdminClient();
  const { data: existingMemberships, error: membershipLookupError } = await admin
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .limit(1);

  if (membershipLookupError) {
    throw new Error(`Onboarding failed while checking memberships: ${membershipLookupError.message}`);
  }

  if ((existingMemberships?.length ?? 0) === 0) {
    const { data: createdOrg, error: createOrgError } = await admin
      .from("orgs")
      .insert({ name: buildOrgName(user.email) })
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
