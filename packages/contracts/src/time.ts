/**
 * Organisation-timezone date helpers (default Asia/Tokyo).
 * Storage is timestamptz / date; display and "today" are always computed in the organisation timezone,
 * never by truncating UTC timestamps.
 */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFormatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_EN: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(instant: Date | string, timeZone = DEFAULT_TIMEZONE): ZonedParts {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new RangeError("Invalid date");
  const out: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(d)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_EN[out.weekday ?? "Sun"] ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD of the instant in the organisation timezone. */
export function zonedDateString(instant: Date | string, timeZone = DEFAULT_TIMEZONE): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Offset (minutes east of UTC) of the timezone at the given instant. */
export function timezoneOffsetMinutes(instant: Date, timeZone = DEFAULT_TIMEZONE): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strictly parses YYYY-MM-DD, rejecting non-existent dates such as 2026-02-30. */
export function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** The UTC instant at which the given local wall-clock time occurs in the timezone. */
export function zonedTimeToInstant(date: string, time = "00:00:00", timeZone = DEFAULT_TIMEZONE): Date {
  const d = parseDateOnly(date);
  if (!d) throw new RangeError(`Invalid date: ${date}`);
  const [hh = 0, mm = 0, ss = 0] = time.split(":").map(Number);
  const guess = new Date(Date.UTC(d.year, d.month - 1, d.day, hh, mm, ss));
  // Two-pass correction handles zones with DST; Asia/Tokyo converges immediately.
  let instant = new Date(guess.getTime() - timezoneOffsetMinutes(guess, timeZone) * 60000);
  instant = new Date(guess.getTime() - timezoneOffsetMinutes(instant, timeZone) * 60000);
  return instant;
}

/** [start, end) instants covering the local calendar day. */
export function zonedDayRange(date: string, timeZone = DEFAULT_TIMEZONE): { start: Date; end: Date } {
  const start = zonedTimeToInstant(date, "00:00:00", timeZone);
  const next = addDays(date, 1);
  return { start, end: zonedTimeToInstant(next, "00:00:00", timeZone) };
}

/** [start, end) instants covering a YYYY-MM month in the timezone. */
export function zonedMonthRange(month: string, timeZone = DEFAULT_TIMEZONE): { start: Date; end: Date; firstDay: string; lastDay: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new RangeError(`Invalid month: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new RangeError(`Invalid month: ${month}`);
  const firstDay = `${year}-${pad(mon)}-01`;
  const nextMonth = mon === 12 ? `${year + 1}-01-01` : `${year}-${pad(mon + 1)}-01`;
  return {
    start: zonedTimeToInstant(firstDay, "00:00:00", timeZone),
    end: zonedTimeToInstant(nextMonth, "00:00:00", timeZone),
    firstDay,
    lastDay: addDays(nextMonth, -1),
  };
}

export function addDays(date: string, days: number): string {
  const d = parseDateOnly(date);
  if (!d) throw new RangeError(`Invalid date: ${date}`);
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function addMonths(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new RangeError(`Invalid month: ${month}`);
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

export function weekdayOfDate(date: string): number {
  const d = parseDateOnly(date);
  if (!d) throw new RangeError(`Invalid date: ${date}`);
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** "10月5日（月）" for a YYYY-MM-DD date-only value. */
export function formatDateJa(date: string, opts: { withYear?: boolean } = {}): string {
  const d = parseDateOnly(date);
  if (!d) return date;
  const w = WEEKDAYS_JA[weekdayOfDate(date)];
  return `${opts.withYear ? `${d.year}年` : ""}${d.month}月${d.day}日（${w}）`;
}

/** "2026年10月2日（金）" for an instant in the organisation timezone. */
export function formatInstantDateJa(instant: Date | string, timeZone = DEFAULT_TIMEZONE, opts: { withYear?: boolean } = { withYear: true }): string {
  return formatDateJa(zonedDateString(instant, timeZone), opts);
}

/** "14:00" in the organisation timezone. */
export function formatTimeJa(instant: Date | string, timeZone = DEFAULT_TIMEZONE): string {
  const p = zonedParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "10/5（月）14:00–15:30" */
export function formatSlotRangeJa(startsAt: Date | string, endsAt: Date | string, timeZone = DEFAULT_TIMEZONE): string {
  const p = zonedParts(startsAt, timeZone);
  return `${p.month}/${p.day}（${WEEKDAYS_JA[p.weekday]}）${formatTimeJa(startsAt, timeZone)}–${formatTimeJa(endsAt, timeZone)}`;
}

/** "10月5日（月）14:00" */
export function formatDateTimeJa(instant: Date | string, timeZone = DEFAULT_TIMEZONE): string {
  return `${formatInstantDateJa(instant, timeZone, { withYear: false })}${formatTimeJa(instant, timeZone)}`;
}

/** "2026年10月" */
export function formatMonthJa(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${Number(m[1])}年${Number(m[2])}月` : month;
}

/**
 * Overdue is derived from the date-only due date and the organisation's local "today";
 * completed items are never overdue.
 */
export function isOverdue(dueDate: string, today: string, completed: boolean): boolean {
  return !completed && dueDate < today;
}
