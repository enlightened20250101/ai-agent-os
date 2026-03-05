type StatusNoticeProps = {
  ok?: string;
  error?: string;
  className?: string;
};

export function StatusNotice({ ok, error, className }: StatusNoticeProps) {
  if (!ok && !error) return null;
  return (
    <div className={className}>
      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      ) : null}
      {ok ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{ok}</p>
      ) : null}
    </div>
  );
}

