import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";

export default function LogoutPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">ログアウト</h1>
      <p className="text-center text-slate-600">下のボタンで現在のセッションを終了できます。</p>
      <LogoutButton />
      <Link href="/app">アプリへ戻る</Link>
    </main>
  );
}
