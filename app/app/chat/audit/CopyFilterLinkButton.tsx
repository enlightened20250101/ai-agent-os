"use client";

import { useState } from "react";

type CopyFilterLinkButtonProps = {
  path: string;
};

export function CopyFilterLinkButton({ path }: CopyFilterLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    try {
      const absolute = `${window.location.origin}${path}`;
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
    >
      {copied ? "リンクコピー済み" : "条件リンクをコピー"}
    </button>
  );
}
