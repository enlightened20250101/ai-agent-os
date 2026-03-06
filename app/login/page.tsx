import { AuthForm } from "@/components/AuthForm";

type LoginPageProps = {
  searchParams?: Promise<{ invite?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = searchParams ? await searchParams : {};
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6">
      <AuthForm mode="login" inviteToken={sp.invite ?? null} />
    </main>
  );
}
