"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type LogoutButtonProps = {
  className?: string;
  label?: string;
  pendingLabel?: string;
};

export function LogoutButton({
  className = "rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100",
  label = "ログアウト",
  pendingLabel = "ログアウト中..."
}: LogoutButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onLogout() {
    startTransition(async () => {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/login");
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onLogout}
      disabled={isPending}
    >
      {isPending ? pendingLabel : label}
    </button>
  );
}
