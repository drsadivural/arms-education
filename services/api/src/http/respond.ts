import type { AppContext } from "../context";

/** {data, checked_at} envelope. `version` is echoed as a strong ETag for If-Match. */
export function ok<T>(c: AppContext, data: T, opts: { status?: 200 | 201; version?: number } = {}) {
  if (opts.version !== undefined) c.header("ETag", `"${opts.version}"`);
  return c.json({ data, checked_at: c.get("deps").now().toISOString() }, opts.status ?? 200);
}

export function page<T>(c: AppContext, items: T[], nextCursor: string | null) {
  return c.json({ items, next_cursor: nextCursor, checked_at: c.get("deps").now().toISOString() });
}

export function action(c: AppContext, data?: Record<string, unknown>, status: 200 | 201 = 200) {
  return c.json({ success: true, checked_at: c.get("deps").now().toISOString(), ...(data ? { data } : {}) }, status);
}
