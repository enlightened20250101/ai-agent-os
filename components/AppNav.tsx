"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavLink = {
  href: string;
  label: string;
};

type AppNavProps = {
  links: NavLink[];
};

export function AppNav({ links }: AppNavProps) {
  const pathname = usePathname();

  return (
    <nav className="flex min-w-max items-center gap-1.5 whitespace-nowrap px-1 md:min-w-0 md:flex-wrap md:gap-2 md:whitespace-normal md:px-0">
      {links.map((link) => {
        const isActive =
          link.href === "/app"
            ? pathname === "/app"
            : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-full px-2.5 py-1 text-xs transition md:px-3 md:py-1.5 md:text-sm ${
              isActive
                ? "bg-slate-900 text-white hover:text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
