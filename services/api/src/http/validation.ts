import type { z } from "zod";
import type { AppContext } from "../context";
import { ApiError, fail } from "./errors";

const MAX_JSON_BYTES = 1_000_000;

export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "_";
    out[key] ??= issue.message;
  }
  return out;
}

/** Parses and validates a JSON body. Responds 422 with Japanese field errors on failure. */
export async function readBody<S extends z.ZodType>(c: AppContext, schema: S): Promise<z.infer<S>> {
  const type = c.req.header("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) fail("BAD_REQUEST", { message_ja: "JSON形式で送信してください。" });
  const length = Number(c.req.header("Content-Length") ?? "0");
  if (length > MAX_JSON_BYTES) fail("BAD_REQUEST", { message_ja: "送信データが大きすぎます。" });
  let raw: unknown;
  try {
    const text = await c.req.text();
    if (text.length > MAX_JSON_BYTES) fail("BAD_REQUEST", { message_ja: "送信データが大きすぎます。" });
    raw = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof ApiError) throw e;
    fail("BAD_REQUEST", { message_ja: "JSONの形式が正しくありません。" });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED", { field_errors: zodFieldErrors(parsed.error) });
  return parsed.data;
}

/** Validates query parameters (unknown parameters are ignored, invalid values → 422). */
export function readQuery<S extends z.ZodType>(c: AppContext, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED", { field_errors: zodFieldErrors(parsed.error) });
  return parsed.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string | undefined | null): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Path UUID parameter; malformed ids are indistinguishable from missing resources (404). */
export function pathId(c: AppContext, name = "id"): string {
  const v = c.req.param(name);
  if (!isUuid(v)) fail("NOT_FOUND");
  return v.toLowerCase();
}

/** Optimistic concurrency: `If-Match: "<row_version>"` is required for PATCH/DELETE. */
export function requireIfMatch(c: AppContext): number {
  const h = c.req.header("If-Match");
  const m = h ? /^(?:W\/)?"?(\d+)"?$/.exec(h.trim()) : null;
  if (!m) fail("IF_MATCH_REQUIRED");
  return Number(m[1]);
}
