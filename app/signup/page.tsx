import { AuthForm } from "@/components/AuthForm";

type SignupPageProps = {
  searchParams?: Promise<{ invite?: string; workspace_name?: string }>;
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const sp = searchParams ? await searchParams : {};
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6">
      <AuthForm mode="signup" inviteToken={sp.invite ?? null} defaultWorkspaceName={sp.workspace_name ?? ""} />
    </main>
  );
}
