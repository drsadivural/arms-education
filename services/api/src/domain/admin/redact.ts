/**
 * Audit details are shown to administrators (WEB-19). Keys that could carry credentials or private content are
 * removed at any depth, whatever module wrote the event.
 */
const SECRET_KEY = /token|secret|password|passwd|passcode|meeting_?url|answer_?key|transcript|api_?key|authorization|cookie|csrf|credential|encrypted|private_?key|totp|mfa_?code/i;
const MAX_DEPTH = 8;
const MAX_STRING = 2000;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (depth >= MAX_DEPTH) return "…";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isSecretKey(k)) out[k] = redact(v, depth + 1);
  }
  return out;
}
