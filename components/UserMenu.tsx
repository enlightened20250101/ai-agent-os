"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { LogoutButton } from "@/components/LogoutButton";

type UserMenuProps = {
  displayName: string;
  email: string;
  jobTitle?: string | null;
  avatarUrl?: string | null;
  settingsLabel: string;
  locale: "ja" | "en";
  pendingApprovalsCount?: number;
  openExceptionsCount?: number;
};

type RecentPage = {
  path: string;
  label: string;
};

const RECENT_PAGES_KEY = "ai_agent_os_recent_pages_v1";

function toPageLabel(path: string) {
  if (path === "/app") return "ホーム";
  if (path.startsWith("/app/chat/shared")) return "共有チャット";
  if (path.startsWith("/app/chat/me")) return "個人チャット";
  if (path.startsWith("/app/chat/channels")) return "チャンネル";
  if (path.startsWith("/app/tasks")) return "タスク";
  if (path.startsWith("/app/approvals")) return "承認";
  if (path.startsWith("/app/cases")) return "案件";
  if (path.startsWith("/app/events")) return "外部イベント";
  if (path.startsWith("/app/executions")) return "実行履歴";
  if (path.startsWith("/app/settings")) return "設定";
  if (path.startsWith("/app/workspace")) return "ワークスペース";
  if (path.startsWith("/app/proposals")) return "提案";
  if (path.startsWith("/app/planner")) return "プランナー";
  if (path.startsWith("/app/monitor")) return "監視";
  return path.replace("/app/", "");
}

function readRecentPages(): RecentPage[] {
  try {
    const raw = window.localStorage.getItem(RECENT_PAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        if (typeof row !== "object" || row === null) return null;
        const item = row as Record<string, unknown>;
        const path = typeof item.path === "string" ? item.path : "";
        const label = typeof item.label === "string" ? item.label : "";
        if (!path.startsWith("/app")) return null;
        return { path, label: label || toPageLabel(path) };
      })
      .filter((row): row is RecentPage => row !== null)
      .slice(0, 3);
  } catch {
    return [];
  }
}

function writeRecentPages(rows: RecentPage[]) {
  try {
    window.localStorage.setItem(RECENT_PAGES_KEY, JSON.stringify(rows.slice(0, 3)));
  } catch {
    // no-op
  }
}

function initials(name: string) {
  const base = name.trim();
  if (!base) return "U";
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (parts[0]?.slice(0, 2) ?? "U").toUpperCase();
}

export function UserMenu({
  displayName,
  email,
  jobTitle,
  avatarUrl,
  settingsLabel,
  locale,
  pendingApprovalsCount = 0,
  openExceptionsCount = 0
}: UserMenuProps) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [recentPages, setRecentPages] = useState<RecentPage[]>([]);
  const query = search?.toString() ?? "";
  const returnTo = `${pathname}${query ? `?${query}` : ""}`;
  const jaHref = `/api/preferences/locale?locale=ja&return_to=${encodeURIComponent(returnTo)}`;
  const enHref = `/api/preferences/locale?locale=en&return_to=${encodeURIComponent(returnTo)}`;
  const initial = initials(displayName || email);
  const quickActions =
    locale === "en"
      ? [
          { key: "tasks", href: "/app/tasks", label: "Create Task", count: 0 },
          { key: "approvals", href: "/app/approvals", label: "Review Approvals", count: pendingApprovalsCount },
          { key: "exceptions", href: "/app/operations/exceptions", label: "Exceptions", count: openExceptionsCount },
          { key: "chat", href: "/app/chat/shared", label: "Open Shared Chat", count: 0 }
        ]
      : [
          { key: "tasks", href: "/app/tasks", label: "タスク作成へ", count: 0 },
          { key: "approvals", href: "/app/approvals", label: "承認確認へ", count: pendingApprovalsCount },
          { key: "exceptions", href: "/app/operations/exceptions", label: "例外キューへ", count: openExceptionsCount },
          { key: "chat", href: "/app/chat/shared", label: "共有チャットへ", count: 0 }
        ];
  const currentPath = useMemo(() => pathname ?? "/app", [pathname]);

  useEffect(() => {
    if (!currentPath.startsWith("/app")) return;
    const existing = readRecentPages();
    const next: RecentPage[] = [{ path: currentPath, label: toPageLabel(currentPath) }];
    for (const row of existing) {
      if (row.path === currentPath) continue;
      next.push(row);
      if (next.length >= 3) break;
    }
    writeRecentPages(next);
    setRecentPages(next.filter((row) => row.path !== currentPath).slice(0, 3));
  }, [currentPath]);

  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center rounded-full border border-slate-200 bg-white p-1 hover:bg-slate-50">
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt={displayName}
            width={32}
            height={32}
            className="h-8 w-8 rounded-full object-cover"
            unoptimized
          />
        ) : (
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
            {initial}
          </span>
        )}
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
        <div className="rounded-lg bg-slate-50 p-2">
          <p className="truncate text-sm font-semibold text-slate-900">{displayName || "ユーザー"}</p>
          {jobTitle ? <p className="truncate text-xs text-slate-600">{jobTitle}</p> : null}
          <p className="truncate text-xs text-slate-500">{email}</p>
        </div>
        <div className="mt-2 space-y-1">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-1">
            <p className="px-1 py-1 text-[11px] font-medium text-slate-500">
              {locale === "en" ? "Quick Actions" : "クイックアクション"}
            </p>
            {quickActions.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
              >
                <span>{item.label}</span>
                {item.count > 0 ? (
                  <span
                    className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      item.key === "exceptions"
                        ? "bg-rose-100 text-rose-700"
                        : item.key === "approvals"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {item.count}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
          {recentPages.length > 0 ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-1">
              <p className="px-1 py-1 text-[11px] font-medium text-slate-500">最近使ったページ</p>
              {recentPages.map((item) => (
                <Link
                  key={item.path}
                  href={item.path}
                  className="block rounded px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-1 rounded-md border border-slate-200 bg-slate-50 p-1 text-xs">
            <Link
              href={jaHref}
              className={`rounded px-2 py-1 text-center ${locale === "ja" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}
            >
              日本語
            </Link>
            <Link
              href={enHref}
              className={`rounded px-2 py-1 text-center ${locale === "en" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}
            >
              English
            </Link>
          </div>
          <Link href="/app/settings" className="block rounded-md px-2 py-2 text-sm text-slate-700 hover:bg-slate-100">
            {settingsLabel}
          </Link>
          <LogoutButton
            className="w-full rounded-md border border-slate-200 px-2 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
          />
        </div>
      </div>
    </details>
  );
}
