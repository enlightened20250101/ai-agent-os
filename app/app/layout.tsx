import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/components/LogoutButton";

const NAV_LINKS = [
  { href: "/app", label: "Home" },
  { href: "/app/agents", label: "Agents" },
  { href: "/app/tasks", label: "Tasks" },
  { href: "/app/approvals", label: "Approvals" }
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-6">
            <Link className="text-lg font-semibold text-slate-900 hover:text-slate-900" href="/app">
              AI Agent OS
            </Link>
            <nav className="flex items-center gap-4">
              {NAV_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className="text-sm text-slate-600 hover:text-slate-900">
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-sm text-slate-600">{user.email}</p>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
