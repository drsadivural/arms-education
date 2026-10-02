import type { z } from "zod";
import { base64UrlDecode, base64UrlEncode } from "../auth/crypto";
import { fail } from "./errors";

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export function parseLimit(value: string | undefined, def = DEFAULT_LIMIT): number {
  if (value === undefined || value === "") return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) fail("VALIDATION_FAILED", { field_errors: { limit: `1〜${MAX_LIMIT}の整数を指定してください。` } });
  return n;
}

/** Opaque keyset cursor: base64url(JSON). The decoder validates the shape with a schema. */
export function encodeCursor(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeCursor<S extends z.ZodType>(value: string | undefined, schema: S): z.infer<S> | null {
  if (!value) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(base64UrlDecode(value))));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  return fail("BAD_REQUEST", { message_ja: "ページ指定が正しくありません。一覧を再読み込みしてください。" });
}

/** Fetch limit+1 rows; returns the page and the cursor built from the last row when more exist. */
export function paginate<T>(rows: T[], limit: number, cursorOf: (row: T) => unknown): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(cursorOf(items[items.length - 1] as T)) };
}
