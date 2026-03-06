export function resolveSafeAppReturnTo(raw: string | null | undefined, fallback: string) {
  const value = String(raw ?? "").trim();
  if (!value.startsWith("/app/")) return fallback;
  return value;
}

export function withMessageOnReturnTo(args: {
  returnTo: string;
  kind: "ok" | "error";
  message: string;
}) {
  const [base, query = ""] = args.returnTo.split("?");
  const params = new URLSearchParams(query);
  params.set(args.kind, args.message);
  return `${base}?${params.toString()}`;
}
