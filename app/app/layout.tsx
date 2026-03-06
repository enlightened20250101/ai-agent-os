import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/AppSidebar";
import { getLatestOpenIncident } from "@/lib/governance/incidents";
import { getAppLocale } from "@/lib/i18n/locale";
import { createClient } from "@/lib/supabase/server";

function severityLabel(severity: string) {
  if (severity === "critical") return "重大";
  if (severity === "high") return "高";
  if (severity === "medium") return "中";
  if (severity === "low") return "低";
  return severity;
}

function isMissingUserProfilesColumn(message: string, columnName: string) {
  return (
    message.includes(`Could not find the '${columnName}' column`) ||
    message.includes(`column user_profiles.${columnName} does not exist`) ||
    message.includes(`column "${columnName}" does not exist`)
  );
}

const JA = {
  appTitle: "AI Agent OS",
  workspacePrefix: "ワークスペース",
  unnamedWorkspace: "名称未設定",
  settings: "設定",
  groups: {
    workspace: "チーム",
    operations: "運用・監査",
    governance: "ガバナンス",
    integrations: "連携"
  }
};

const EN = {
  appTitle: "AI Agent OS",
  workspacePrefix: "Workspace",
  unnamedWorkspace: "Unnamed",
  settings: "Settings",
  groups: {
    workspace: "Team",
    operations: "Operations",
    governance: "Governance",
    integrations: "Integrations"
  }
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const locale = await getAppLocale();
  const isEn = locale === "en";
  const t = isEn ? EN : JA;
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const orgId = membership?.org_id as string | undefined;
  const { data: orgRow } = orgId
    ? await supabase.from("orgs").select("name").eq("id", orgId).maybeSingle()
    : { data: null };
  const orgName = (orgRow?.name as string | null | undefined) ?? t.unnamedWorkspace;
  const profileRes = orgId
    ? await supabase
        .from("user_profiles")
        .select("display_name, avatar_url, job_title")
        .eq("org_id", orgId)
        .eq("user_id", user.id)
        .maybeSingle()
    : { data: null, error: null };
  if (
    profileRes.error &&
    !profileRes.error.message.includes('relation "user_profiles" does not exist') &&
    !profileRes.error.message.includes("Could not find the table 'public.user_profiles'") &&
    !isMissingUserProfilesColumn(profileRes.error.message, "job_title")
  ) {
    throw new Error(`Failed to load user profile: ${profileRes.error.message}`);
  }
  const profile = (profileRes.data ?? null) as {
    display_name?: string | null;
    avatar_url?: string | null;
    job_title?: string | null;
  } | null;
  const displayName = profile?.display_name?.trim() || (user.email?.split("@")[0] ?? "User");
  const openIncident = orgId ? await getLatestOpenIncident({ supabase, orgId }) : null;
  const [pendingApprovalsRes, openExceptionsRes] = orgId
    ? await Promise.all([
        supabase
          .from("approvals")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "pending"),
        supabase
          .from("exception_cases")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .in("status", ["open", "in_progress"])
      ])
    : [null, null];
  if (pendingApprovalsRes?.error) {
    throw new Error(`Failed to load pending approvals count: ${pendingApprovalsRes.error.message}`);
  }
  if (
    openExceptionsRes?.error &&
    !openExceptionsRes.error.message.includes('relation "exception_cases" does not exist') &&
    !openExceptionsRes.error.message.includes("Could not find the table 'public.exception_cases'")
  ) {
    throw new Error(`Failed to load open exceptions count: ${openExceptionsRes.error.message}`);
  }
  const pendingApprovalsCount = pendingApprovalsRes?.count ?? 0;
  const openExceptionsCount = openExceptionsRes?.count ?? 0;

  const primaryLinks = isEn
    ? [
        { href: "/app", label: "Home" },
        { href: "/app/chat/shared", label: "Shared Chat" },
        { href: "/app/tasks", label: "Tasks" },
        { href: "/app/approvals", label: "Approvals" },
        { href: "/app/cases", label: "Cases" }
      ]
    : [
        { href: "/app", label: "ホーム" },
        { href: "/app/chat/shared", label: "共有チャット" },
        { href: "/app/tasks", label: "タスク" },
        { href: "/app/approvals", label: "承認" },
        { href: "/app/cases", label: "案件" }
      ];

  const groups = isEn
    ? [
        {
          id: "workspace",
          label: t.groups.workspace,
          defaultOpen: true,
          links: [
            { href: "/app/workspace", label: "Workspace" },
            { href: "/app/chat/channels", label: "Channels" },
            { href: "/app/chat/me", label: "My Chat" },
            { href: "/app/agents", label: "Agents" },
            { href: "/app/partners", label: "Partners" }
          ]
        },
        {
          id: "operations",
          label: t.groups.operations,
          links: [
            { href: "/app/proposals", label: "Proposals" },
            { href: "/app/planner", label: "Planner" },
            { href: "/app/monitor", label: "Monitor" },
            { href: "/app/events", label: "Events" },
            { href: "/app/executions", label: "Executions" },
            { href: "/app/workflows", label: "Workflows" },
            { href: "/app/operations/jobs", label: "Jobs" },
            { href: "/app/operations/exceptions", label: "Exceptions" },
            { href: "/app/chat/audit", label: "Chat Audit" }
          ]
        },
        {
          id: "governance",
          label: t.groups.governance,
          links: [
            { href: "/app/governance/autonomy", label: "Autonomy" },
            { href: "/app/governance/recommendations", label: "Recommendations" },
            { href: "/app/governance/budgets", label: "Budgets" },
            { href: "/app/governance/trust", label: "Trust" },
            { href: "/app/governance/incidents", label: "Incidents" }
          ]
        },
        {
          id: "integrations",
          label: t.groups.integrations,
          links: [
            { href: "/app/integrations/slack", label: "Slack" },
            { href: "/app/integrations/google", label: "Google" }
          ]
        }
      ]
    : [
        {
          id: "workspace",
          label: t.groups.workspace,
          defaultOpen: true,
          links: [
            { href: "/app/workspace", label: "ワークスペース" },
            { href: "/app/chat/channels", label: "チャンネル" },
            { href: "/app/chat/me", label: "個人チャット" },
            { href: "/app/agents", label: "エージェント" },
            { href: "/app/partners", label: "取引先" }
          ]
        },
        {
          id: "operations",
          label: t.groups.operations,
          links: [
            { href: "/app/proposals", label: "提案" },
            { href: "/app/planner", label: "プランナー" },
            { href: "/app/monitor", label: "監視" },
            { href: "/app/events", label: "外部イベント" },
            { href: "/app/executions", label: "実行履歴" },
            { href: "/app/workflows", label: "ワークフロー" },
            { href: "/app/operations/jobs", label: "ジョブ" },
            { href: "/app/operations/exceptions", label: "例外キュー" },
            { href: "/app/chat/audit", label: "チャット監査" }
          ]
        },
        {
          id: "governance",
          label: t.groups.governance,
          links: [
            { href: "/app/governance/autonomy", label: "自律設定" },
            { href: "/app/governance/recommendations", label: "改善提案" },
            { href: "/app/governance/budgets", label: "予算" },
            { href: "/app/governance/trust", label: "信頼スコア" },
            { href: "/app/governance/incidents", label: "インシデント" }
          ]
        },
        {
          id: "integrations",
          label: t.groups.integrations,
          links: [
            { href: "/app/integrations/slack", label: "Slack" },
            { href: "/app/integrations/google", label: "Google" }
          ]
        }
      ];

  const workspaceLabel = `${t.workspacePrefix}: ${orgName}`;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex min-h-screen">
        <AppSidebar
          appTitle={t.appTitle}
          workspaceLabel={workspaceLabel}
          userEmail={user.email ?? "-"}
          displayName={displayName}
          jobTitle={profile?.job_title ?? null}
          avatarUrl={profile?.avatar_url ?? null}
          locale={isEn ? "en" : "ja"}
          pendingApprovalsCount={pendingApprovalsCount}
          openExceptionsCount={openExceptionsCount}
          primaryLinks={primaryLinks}
          groups={groups}
          settingsLink={{ href: "/app/settings", label: `⚙ ${t.settings}` }}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {openIncident ? (
            <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800 md:px-6">
              インシデントモード有効: {severityLabel(openIncident.severity)} / {openIncident.reason}
            </div>
          ) : null}
          <main className="min-w-0 px-4 py-5 md:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
