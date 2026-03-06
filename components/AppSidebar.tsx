"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { UserMenu } from "@/components/UserMenu";

type NavLink = {
  href: string;
  label: string;
};

type NavGroup = {
  id: string;
  label: string;
  defaultOpen?: boolean;
  links: NavLink[];
};

type AppSidebarProps = {
  appTitle: string;
  workspaceLabel: string;
  userEmail: string;
  displayName: string;
  jobTitle?: string | null;
  avatarUrl?: string | null;
  locale: "ja" | "en";
  pendingApprovalsCount?: number;
  openExceptionsCount?: number;
  groups: NavGroup[];
  primaryLinks: NavLink[];
  settingsLink: NavLink;
};

function isActivePath(pathname: string, href: string) {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinkItem({ link, compact = false }: { link: NavLink; compact?: boolean }) {
  const pathname = usePathname();
  const active = isActivePath(pathname, link.href);
  return (
    <Link
      href={link.href}
      className={`block rounded-lg px-3 py-2 text-sm transition ${
        active
          ? "bg-slate-900 text-white"
          : compact
            ? "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      {link.label}
    </Link>
  );
}

function SidebarContent({
  appTitle,
  workspaceLabel,
  userEmail,
  displayName,
  jobTitle,
  avatarUrl,
  locale,
  pendingApprovalsCount = 0,
  openExceptionsCount = 0,
  groups,
  primaryLinks,
  settingsLink
}: AppSidebarProps) {
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Link href="/app" className="block text-lg font-semibold tracking-tight text-slate-900">
            {appTitle}
          </Link>
          <UserMenu
            displayName={displayName}
            email={userEmail}
            jobTitle={jobTitle}
            avatarUrl={avatarUrl}
            settingsLabel={settingsLink.label}
            locale={locale}
            pendingApprovalsCount={pendingApprovalsCount}
            openExceptionsCount={openExceptionsCount}
          />
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <p className="font-medium text-slate-700">{workspaceLabel}</p>
          <p className="mt-0.5 truncate">{userEmail}</p>
        </div>
      </div>

      <nav className="space-y-1">
        {primaryLinks.map((link) => (
          <NavLinkItem key={link.href} link={link} />
        ))}
      </nav>

      <div className="space-y-2 overflow-y-auto pr-1">
        {groups.map((group) => (
          <details
            key={group.id}
            open={group.defaultOpen}
            className="rounded-lg border border-slate-200 bg-white"
          >
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold tracking-wide text-slate-600">
              {group.label}
            </summary>
            <div className="space-y-1 px-2 pb-2">
              {group.links.map((link) => (
                <NavLinkItem key={link.href} link={link} compact />
              ))}
            </div>
          </details>
        ))}
      </div>

      <div className="mt-auto border-t border-slate-200 pt-3" />
    </div>
  );
}

export function AppSidebar(props: AppSidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <aside className="hidden h-screen w-72 shrink-0 border-r border-slate-200 bg-white lg:sticky lg:top-0 lg:block lg:overflow-y-auto">
        <div className="px-4 py-5">
        <SidebarContent {...props} />
        </div>
      </aside>

      <div className="sticky top-0 z-30 border-b border-slate-200 bg-white px-4 py-2 lg:hidden">
        <div className="flex items-center justify-between gap-2">
          <Link href="/app" className="truncate text-base font-semibold text-slate-900">
            {props.appTitle}
          </Link>
          <div className="flex items-center gap-2">
            <UserMenu
              displayName={props.displayName}
              email={props.userEmail}
              jobTitle={props.jobTitle}
              avatarUrl={props.avatarUrl}
              settingsLabel={props.settingsLink.label}
              locale={props.locale}
              pendingApprovalsCount={props.pendingApprovalsCount ?? 0}
              openExceptionsCount={props.openExceptionsCount ?? 0}
            />
            <button
              type="button"
              onClick={() => setMobileOpen((prev) => !prev)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700"
            >
              {mobileOpen ? "閉じる" : "メニュー"}
            </button>
          </div>
        </div>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div
            className="h-full w-80 max-w-[88%] bg-white px-4 py-4"
            onClick={(event) => event.stopPropagation()}
          >
            <SidebarContent {...props} />
          </div>
        </div>
      ) : null}
    </>
  );
}
