"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type AuthMode = "login" | "signup";

type AuthFormProps = {
  mode: AuthMode;
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isLogin = mode === "login";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const authResult = isLogin
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });

    setIsSubmitting(false);

    if (authResult.error) {
      setError(authResult.error.message);
      return;
    }

    if (!isLogin && !authResult.data.session) {
      setError("登録は完了しました。メール確認後にログインしてください。");
      return;
    }

    router.push("/app");
    router.refresh();
  }

  return (
    <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold">{isLogin ? "ログイン" : "アカウント作成"}</h1>
      <p className="mt-2 text-sm text-slate-600">
        {isLogin
          ? "ワークスペースにアクセスするためにログインしてください。"
          : "AI Agent OS を利用するためのアカウントを作成します。"}
      </p>

      <form className="mt-6 space-y-4" onSubmit={onSubmit}>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="email">
            メールアドレス
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-500 focus:ring-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="password">
            パスワード
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-500 focus:ring-2"
          />
        </div>

        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? "処理中..." : isLogin ? "ログイン" : "新規登録"}
        </button>
      </form>

      <p className="mt-4 text-sm text-slate-600">
        {isLogin ? "アカウントをお持ちでないですか？" : "すでにアカウントをお持ちですか？"}{" "}
        <Link className="font-medium" href={isLogin ? "/signup" : "/login"}>
          {isLogin ? "新規登録" : "ログイン"}
        </Link>
      </p>
    </div>
  );
}
