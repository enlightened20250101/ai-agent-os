import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type MembershipRow = {
  org_id: string;
  role: string;
};

export type OrgContext = {
  orgId: string;
  role: string;
  userId: string;
  userEmail: string | null;
};

export async function requireOrgContext(): Promise<OrgContext> {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data, error } = await supabase
    .from("memberships")
    .select("org_id, role")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load org membership: ${error.message}`);
  }

  const membership = (data?.[0] ?? null) as MembershipRow | null;
  if (!membership) {
    redirect("/app/onboarding");
  }

  return {
    orgId: membership.org_id,
    role: membership.role,
    userId: user.id,
    userEmail: user.email ?? null
  };
}

export async function getOptionalOrgContext(): Promise<OrgContext | null> {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("memberships")
    .select("org_id, role")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load org membership: ${error.message}`);
  }

  const membership = (data?.[0] ?? null) as MembershipRow | null;
  if (!membership) {
    return null;
  }

  return {
    orgId: membership.org_id,
    role: membership.role,
    userId: user.id,
    userEmail: user.email ?? null
  };
}
