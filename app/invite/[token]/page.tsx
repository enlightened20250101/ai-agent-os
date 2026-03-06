import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type InvitePageProps = {
  params: Promise<{ token: string }>;
};

export default async function InviteRedirectPage({ params }: InvitePageProps) {
  const { token } = await params;
  const safeToken = token.trim();
  if (!safeToken) {
    redirect("/signup");
  }
  const userClient = await createClient();
  const {
    data: { user }
  } = await userClient.auth.getUser();
  if (user) {
    redirect(`/app/onboarding?invite_token=${encodeURIComponent(safeToken)}`);
  }

  const admin = createAdminClient();
  const { data: invite } = await admin
    .from("org_invite_links")
    .select("org_id")
    .eq("token", safeToken)
    .maybeSingle();

  let workspaceName = "";
  if (invite?.org_id) {
    const { data: org } = await admin.from("orgs").select("name").eq("id", invite.org_id as string).maybeSingle();
    workspaceName = String(org?.name ?? "").trim();
  }

  const search = new URLSearchParams();
  search.set("invite", safeToken);
  if (workspaceName.length > 0) {
    search.set("workspace_name", workspaceName);
  }
  redirect(`/signup?${search.toString()}`);
}
