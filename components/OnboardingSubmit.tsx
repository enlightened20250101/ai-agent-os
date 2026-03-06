"use client";

import { useFormStatus } from "react-dom";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
      disabled={pending}
    >
      {pending ? "ワークスペース作成中..." : "続行"}
    </button>
  );
}

export function OnboardingSubmit() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        ワークスペースを作成、または招待リンクで既存ワークスペースへ参加します。
      </p>
      <SubmitButton />
    </div>
  );
}
