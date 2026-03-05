"use client";

import { useState } from "react";

type CopyButtonProps = {
  value: string;
};

export function CopyButton({ value }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
    >
      {copied ? "コピー済み" : "コピー"}
    </button>
  );
}
