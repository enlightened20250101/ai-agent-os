import { redirect } from "next/navigation";
import { OnboardingSubmit } from "@/components/OnboardingSubmit";
import { createClient } from "@/lib/supabase/server";
import { completeOnboarding } from "@/app/app/onboarding/actions";

export default async function OnboardingPage() {
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
      <div className="mt-6">
        <form id="onboarding-form" action={completeOnboarding}>
          <OnboardingSubmit />
        </form>
      </div>
    </section>
  );
}
