"use client";

import { useMemo, useState } from "react";

type MentionTextareaProps = {
  id: string;
  name: string;
  required?: boolean;
  rows?: number;
  placeholder?: string;
  candidates: string[];
};

export function MentionTextarea({ id, name, required, rows = 3, placeholder, candidates }: MentionTextareaProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  const trigger = useMemo(() => {
    const head = value.slice(0, cursor);
    const m = head.match(/(?:^|\s)@([A-Za-z0-9_.-]*)$/);
    if (!m) return null;
    return {
      query: (m[1] ?? "").toLowerCase(),
      start: cursor - (m[1]?.length ?? 0) - 1,
      end: cursor
    };
  }, [value, cursor]);

  const suggestions = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const matched = candidates.filter((c) => c.toLowerCase().startsWith(q));
    return matched.slice(0, 8);
  }, [trigger, candidates]);

  function applySuggestion(candidate: string) {
    if (!trigger) return;
    const before = value.slice(0, trigger.start);
    const after = value.slice(trigger.end);
    const next = `${before}@${candidate} ${after}`;
    setValue(next);
  }

  return (
    <div className="space-y-2">
      <textarea
        id={id}
        name={name}
        value={value}
        required={required}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
        }}
        onClick={(e) => setCursor((e.currentTarget as HTMLTextAreaElement).selectionStart ?? value.length)}
        onKeyUp={(e) => setCursor((e.currentTarget as HTMLTextAreaElement).selectionStart ?? value.length)}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-0 placeholder:text-slate-400 focus:border-slate-400"
      />
      {trigger && suggestions.length > 0 ? (
        <div className="rounded-md border border-slate-200 bg-white p-2 shadow-sm">
          <p className="mb-1 text-[11px] text-slate-500">mention suggestions</p>
          <div className="flex flex-wrap gap-1">
            {suggestions.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => applySuggestion(candidate)}
                className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
              >
                @{candidate}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
