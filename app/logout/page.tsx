import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";

export default function LogoutPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Logout</h1>
      <p className="text-center text-slate-600">Use the button below to end your current session.</p>
      <LogoutButton />
      <Link href="/app">Back to app</Link>
    </main>
  );
}
