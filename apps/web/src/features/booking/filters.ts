/**
 * URL-backed filters for the booking screens. Every filter lives in the query string so a reload, a shared link
 * or the browser back button restores the same list.
 */
import { formatDateJa, formatMonthJa, parseDateOnly } from "@arms/contracts";

export type PeriodMode = "upcoming" | "month" | "range" | "all";

export interface Period {
  mode: PeriodMode;
  month?: string;
  from?: string;
  to?: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isDate = (v: string | null): v is string => !!v && parseDateOnly(v) !== null;
const isUuid = (v: string | null): v is string => !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Reads the period from `period`, `month`, `from`, `to`; invalid values fall back to `fallback`. */
export function readPeriod(sp: URLSearchParams, fallback: PeriodMode, allowed: readonly PeriodMode[] = ["upcoming", "month", "range", "all"]): Period {
  const month = sp.get("month");
  const from = sp.get("from");
  const to = sp.get("to");
  const mode = sp.get("period") as PeriodMode | null;
  if (allowed.includes("month") && month && MONTH_RE.test(month) && (mode === null || mode === "month")) return { mode: "month", month };
  if (allowed.includes("range") && (mode === "range" || (mode === null && (isDate(from) || isDate(to))))) {
    return { mode: "range", from: isDate(from) ? from : undefined, to: isDate(to) ? to : undefined };
  }
  if (mode && allowed.includes(mode) && mode !== "month" && mode !== "range") return { mode };
  return { mode: fallback };
}

/** Writes the period into `sp` (removing the keys that do not apply). The default mode is not written. */
export function writePeriod(sp: URLSearchParams, p: Period, fallback: PeriodMode): void {
  for (const k of ["period", "month", "from", "to"]) sp.delete(k);
  if (p.mode === "month" && p.month) sp.set("month", p.month);
  else if (p.mode === "range") {
    sp.set("period", "range");
    if (p.from) sp.set("from", p.from);
    if (p.to) sp.set("to", p.to);
  } else if (p.mode !== fallback) sp.set("period", p.mode);
}

/** API query parameters for a period. `today` is the organisation-local date (YYYY-MM-DD). */
export function periodQuery(p: Period, today: string): { from?: string; to?: string; month?: string } {
  switch (p.mode) {
    case "upcoming":
      return { from: today };
    case "month":
      return { month: p.month };
    case "range":
      return { from: p.from, to: p.to };
    case "all":
      return {};
  }
}

export function periodLabel(p: Period): string {
  switch (p.mode) {
    case "upcoming":
      return "今日以降";
    case "month":
      return p.month ? formatMonthJa(p.month) : "月を指定";
    case "range":
      return `${p.from ? formatDateJa(p.from) : "指定なし"}〜${p.to ? formatDateJa(p.to) : "指定なし"}`;
    case "all":
      return "すべての期間";
  }
}

/** Comma-separated allowlisted values (e.g. status=pending,approved). */
export function readList<V extends string>(sp: URLSearchParams, key: string, allowed: readonly V[]): V[] {
  const raw = sp.get(key);
  if (!raw) return [];
  const parts = raw.split(",").map((s) => s.trim());
  return allowed.filter((a) => parts.includes(a));
}

export function readId(sp: URLSearchParams, key: string): string | undefined {
  const v = sp.get(key);
  return isUuid(v) ? v.toLowerCase() : undefined;
}

/** Free-text search term, trimmed and limited to the API maximum (100). */
export function readSearch(sp: URLSearchParams, key = "q"): string {
  return (sp.get(key) ?? "").trim().slice(0, 100);
}

/** Returns a copy of `sp` with `key` set (or removed when empty). */
export function withParam(sp: URLSearchParams, key: string, value: string | readonly string[] | undefined | null): URLSearchParams {
  const next = new URLSearchParams(sp);
  const v = Array.isArray(value) ? value.join(",") : (value as string | undefined | null);
  if (v) next.set(key, v);
  else next.delete(key);
  return next;
}
