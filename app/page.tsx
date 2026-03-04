import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">AI Agent OS</h1>
      <p className="text-slate-600">
        MVP wedge: Slack intake, draft generation, policy gating, approval, Gmail send, and
        evidence-grade event logs.
      </p>
      <div className="flex gap-4">
        <Link className="rounded-md bg-slate-900 px-4 py-2 text-white hover:bg-slate-800" href="/login">
          Login
        </Link>
        <Link className="rounded-md border border-slate-300 px-4 py-2 text-slate-800 hover:bg-slate-100" href="/signup">
          Sign up
        </Link>
      </div>
    </main>
  );
}
