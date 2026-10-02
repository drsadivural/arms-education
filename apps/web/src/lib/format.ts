/** Display helpers bound to the organisation timezone (Asia/Tokyo). */
import {
  DEFAULT_TIMEZONE,
  formatDateJa,
  formatDateTimeJa,
  formatInstantDateJa,
  formatMonthJa,
  formatSlotRangeJa,
  formatTimeJa,
  zonedDateString,
} from "@arms/contracts";

export const ORG_TZ = DEFAULT_TIMEZONE;

export const fmt = {
  /** "10月5日（月）" from a YYYY-MM-DD date-only value (no timezone shift). */
  date: (d: string | null | undefined, withYear = false) => (d ? formatDateJa(d, { withYear }) : "—"),
  /** "2026年10月2日（金）" from an instant. */
  instantDate: (iso: string | Date) => formatInstantDateJa(iso, ORG_TZ),
  /** "14:00" */
  time: (iso: string | Date) => formatTimeJa(iso, ORG_TZ),
  /** "10月5日（月）14:00" */
  dateTime: (iso: string | Date | null | undefined) => (iso ? formatDateTimeJa(iso, ORG_TZ) : "—"),
  /** "10/5（月）14:00–15:30" */
  slotRange: (start: string, end: string) => formatSlotRangeJa(start, end, ORG_TZ),
  month: (m: string) => formatMonthJa(m),
  /** Today's YYYY-MM-DD in the organisation timezone. */
  today: () => zonedDateString(new Date(), ORG_TZ),
  /** "1,234" */
  number: (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("ja-JP")),
  /** "76%" or 「未設定」 for null progress. */
  percent: (n: number | null | undefined) => (n === null || n === undefined ? "未設定" : `${Math.round(n)}%`),
};
