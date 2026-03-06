import { redirect } from "next/navigation";
import { OnboardingSubmit } from "@/components/OnboardingSubmit";
import { createClient } from "@/lib/supabase/server";
import { completeOnboarding } from "@/app/app/onboarding/actions";

type OnboardingPageProps = {
  searchParams?: Promise<{ workspace_name?: string; invite_token?: string; error?: string }>;
};

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const sp = searchParams ? await searchParams : {};
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: existingMemberships, error } = await supabase
    .from("memberships")
    .select("id")
    .limit(1);

  if (!error && (existingMemberships?.length ?? 0) > 0) {
    redirect("/app");
  }

  return (
    <section className="mx-auto mt-16 w-full max-w-xl rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold tracking-tight">オンボーディング</h1>
      <p className="mt-2 text-slate-600">
        組織ワークスペースの初期設定を完了します。
      </p>
      {sp.error ? <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p> : null}
      <div className="mt-6">
        <form id="onboarding-form" action={completeOnboarding}>
          <input type="hidden" name="invite_token" value={sp.invite_token ?? ""} />
          {!sp.invite_token ? (
            <div className="mb-4">
              <label htmlFor="workspace_name" className="mb-1 block text-sm font-medium text-slate-700">
                ワークスペース名
              </label>
              <input
                id="workspace_name"
                name="workspace_name"
                defaultValue={sp.workspace_name ?? ""}
                placeholder="例: Finance Team"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-500 focus:ring-2"
              />
            </div>
          ) : (
            <p className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
              招待リンクが検出されました。
              {sp.workspace_name ? `「${sp.workspace_name}」` : "既存ワークスペース"}へ参加します。
            </p>
          )}
          <OnboardingSubmit />
        </form>
      </div>
    </section>
  );
}
