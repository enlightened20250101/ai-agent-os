import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { getLatestOpenIncident } from "@/lib/governance/incidents";
import { getAppLocale } from "@/lib/i18n/locale";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/components/LogoutButton";

const NAV_LINKS_JA = [
  { href: "/app", label: "ホーム" },
  { href: "/app/agents", label: "エージェント" },
  { href: "/app/cases", label: "案件" },
  { href: "/app/tasks", label: "タスク" },
  { href: "/app/approvals", label: "承認" },
  { href: "/app/workflows", label: "ワークフロー" },
  { href: "/app/chat/shared", label: "共有チャット" },
  { href: "/app/chat/me", label: "個人チャット" },
  { href: "/app/chat/audit", label: "チャット監査" },
  { href: "/app/proposals", label: "提案" },
  { href: "/app/planner", label: "プランナー" },
  { href: "/app/operations/jobs", label: "ジョブ" },
  { href: "/app/operations/exceptions", label: "例外キュー" },
  { href: "/app/governance/autonomy", label: "自律設定" },
  { href: "/app/governance/recommendations", label: "改善提案" },
  { href: "/app/governance/budgets", label: "予算" },
  { href: "/app/governance/trust", label: "Trust" },
  { href: "/app/governance/incidents", label: "インシデント" },
  { href: "/app/integrations/slack", label: "Slack" },
  { href: "/app/integrations/google", label: "Google" }
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const locale = await getAppLocale();
  const isEn = locale === "en";
  const NAV_LINKS = isEn
    ? [
        { href: "/app", label: "Home" },
        { href: "/app/agents", label: "Agents" },
        { href: "/app/cases", label: "Cases" },
        { href: "/app/tasks", label: "Tasks" },
        { href: "/app/approvals", label: "Approvals" },
        { href: "/app/workflows", label: "Workflows" },
        { href: "/app/chat/shared", label: "Shared Chat" },
        { href: "/app/chat/me", label: "My Chat" },
        { href: "/app/chat/audit", label: "Chat Audit" },
        { href: "/app/proposals", label: "Proposals" },
        { href: "/app/planner", label: "Planner" },
        { href: "/app/operations/jobs", label: "Jobs" },
        { href: "/app/operations/exceptions", label: "Exceptions" },
        { href: "/app/governance/autonomy", label: "Autonomy" },
        { href: "/app/governance/recommendations", label: "Recommendations" },
        { href: "/app/governance/budgets", label: "Budgets" },
        { href: "/app/governance/trust", label: "Trust" },
        { href: "/app/governance/incidents", label: "Incidents" },
        { href: "/app/integrations/slack", label: "Slack" },
        { href: "/app/integrations/google", label: "Google" },
        { href: "/app/settings", label: "Settings" }
      ]
    : [...NAV_LINKS_JA, { href: "/app/settings", label: "設定" }];

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
  const openIncident = orgId ? await getLatestOpenIncident({ supabase, orgId }) : null;
  const [plannerRunsRes, reviewEventsRes] = orgId
    ? await Promise.all([
        supabase
          .from("planner_runs")
          .select("status, created_at")
          .eq("org_id", orgId)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("task_events")
          .select("event_type, created_at")
          .eq("org_id", orgId)
          .in("event_type", ["GOVERNANCE_RECOMMENDATIONS_REVIEWED", "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED"])
          .order("created_at", { ascending: false })
          .limit(10)
      ])
    : [null, null];

  const plannerRuns =
    plannerRunsRes && !plannerRunsRes.error
      ? (plannerRunsRes.data ?? []).map((row) => ({ status: (row.status as string | null) ?? null }))
      : [];
  const reviewEvents =
    reviewEventsRes && !reviewEventsRes.error
      ? (reviewEventsRes.data ?? []).map((row) => ({ eventType: (row.event_type as string | null) ?? null }))
      : [];

  let plannerConsecutiveFailures = 0;
  for (const row of plannerRuns) {
    if (row.status === "failed") plannerConsecutiveFailures += 1;
    else break;
  }
  const latestPlannerFailedAt =
    plannerRunsRes && !plannerRunsRes.error
      ? ((plannerRunsRes.data ?? []).find((row) => row.status === "failed")?.created_at as string | undefined) ?? null
      : null;
  let reviewConsecutiveFailures = 0;
  for (const row of reviewEvents) {
    if (row.eventType === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED") reviewConsecutiveFailures += 1;
    else break;
  }
  const latestReviewFailedAt =
    reviewEventsRes && !reviewEventsRes.error
      ? ((reviewEventsRes.data ?? []).find((row) => row.event_type === "GOVERNANCE_RECOMMENDATIONS_REVIEW_FAILED")
          ?.created_at as string | undefined) ?? null
      : null;
  const showOpsBanner = plannerConsecutiveFailures >= 2 || reviewConsecutiveFailures >= 2;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-white">
      <header className="sticky top-0 z-20 border-b border-white/70 bg-white/80 backdrop-blur">
        <div className="mx-auto w-full max-w-6xl px-4 py-2 md:px-6 md:py-4">
          <div className="flex items-center justify-between gap-2">
            <Link className="text-base font-semibold tracking-tight text-slate-900 hover:text-slate-900 md:text-lg" href="/app">
              AI Agent OS
            </Link>
            <div className="flex items-center gap-2">
              <Link
                href="/app/settings"
                className="hidden rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 hover:bg-slate-100 sm:inline-flex"
              >
                {isEn ? "Language" : "言語"}
              </Link>
              <p className="hidden max-w-[220px] truncate rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600 sm:block">
                {user.email}
              </p>
              <LogoutButton />
            </div>
          </div>
          <div className="-mx-1 mt-2 overflow-x-auto md:mx-0 md:mt-3 md:overflow-visible">
            <AppNav links={NAV_LINKS} />
          </div>
          <div className="mt-1 text-[11px] text-slate-500 sm:hidden">
            {user.email}
          </div>
        </div>
      </header>
      {openIncident ? (
        <div className="border-y border-rose-200 bg-rose-50">
          <div className="mx-auto w-full max-w-6xl px-6 py-2 text-sm text-rose-800">
            インシデントモード有効: {openIncident.severity.toUpperCase()} / {openIncident.reason}
          </div>
        </div>
      ) : null}
      {showOpsBanner ? (
        <div className="border-y border-amber-200 bg-amber-50">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-2 text-xs text-amber-800">
            <p className="space-x-1">
              要対応: ジョブ連続失敗 planner={plannerConsecutiveFailures} / review={reviewConsecutiveFailures}
              <span>
                （planner最終失敗: {latestPlannerFailedAt ? new Date(latestPlannerFailedAt).toLocaleString() : "なし"}）
              </span>
              <span>
                （review最終失敗: {latestReviewFailedAt ? new Date(latestReviewFailedAt).toLocaleString() : "なし"}）
              </span>
            </p>
            <Link href="/app/operations/jobs?failed_only=1" className="font-medium underline">
              失敗ジョブを確認
            </Link>
          </div>
        </div>
      ) : null}
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
