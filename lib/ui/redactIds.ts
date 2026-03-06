const ID_KEY_PATTERN = /(?:^|_)(id|ids|token|nonce)$/i;
const UUID_LIKE_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\b/g;

function maskString(value: string) {
  return value
    .replace(UUID_LIKE_PATTERN, "[id]")
    .replace(LONG_TOKEN_PATTERN, (token) => {
      if (token.includes("@")) return token;
      return "[id]";
    });
}

function redactValue(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (keyHint && ID_KEY_PATTERN.test(keyHint)) return "[id]";
    return maskString(value);
  }
  if (Array.isArray(value)) {
    if (keyHint && ID_KEY_PATTERN.test(keyHint)) {
      return value.map(() => "[id]");
    }
    return value.map((item) => redactValue(item));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(child, key);
    }
    return out;
  }
  return value;
}

export function toRedactedJson(value: unknown) {
  return JSON.stringify(redactValue(value), null, 2);
}

