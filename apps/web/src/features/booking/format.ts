/** Japanese display helpers for the booking screens (organisation timezone via lib/format). */
import { RESERVATION_STATUS_LABELS, SLOT_STATE_LABELS } from "@arms/contracts";
import { fmt } from "../../lib/format";

/** 「2026年10月5日（月）14:00」 */
export function dateTimeFull(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${fmt.instantDate(iso)} ${fmt.time(iso)}`;
}

/** 「2026年10月5日（月）14:00–15:30」 */
export function slotRangeFull(start: string, end: string): string {
  return `${fmt.instantDate(start)} ${fmt.time(start)}–${fmt.time(end)}`;
}

/** Time left until a pending hold expires: 「あと23時間12分」, 「あと5分」, 「1分未満」, or null once passed. */
export function holdRemaining(expiresAt: string, now: number): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "あと1分未満";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `あと${days}日${hours}時間`;
  if (hours > 0) return `あと${hours}時間${mins}分`;
  return `あと${mins}分`;
}

/** 「開始24時間前」「開始30分前」「開始時刻まで」 for cancel_before_seconds. */
export function cancelBeforeLabel(seconds: number): string {
  if (seconds <= 0) return "開始時刻まで";
  if (seconds % 86_400 === 0 && seconds >= 172_800) return `開始${seconds / 86_400}日前`;
  if (seconds % 3600 === 0) return `開始${seconds / 3600}時間前`;
  return `開始${Math.round(seconds / 60)}分前`;
}

/** Cancel-deadline presets offered on WEB-15 (seconds before the lesson starts). */
export const CANCEL_BEFORE_PRESETS = [259_200, 172_800, 86_400, 43_200, 21_600, 10_800, 3600, 0] as const;

/** Reservation history (audit) event names. */
export const HISTORY_EVENT_LABELS: Record<string, string> = {
  "reservation.created": "予約申請",
  "reservation.approved": "承認",
  "reservation.rejected": "却下",
  "reservation.cancelled": "取消",
  "reservation.expired": "保持期限切れ",
  "reservation.removed": "削除（履歴を保持）",
};

export function historyEventLabel(eventType: string): string {
  return HISTORY_EVENT_LABELS[eventType] ?? eventType;
}

export function statusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return (RESERVATION_STATUS_LABELS as Record<string, string>)[status] ?? null;
}

/** Statuses shown on the 予約申請 tab filter (removed reservations live in 履歴). */
export const REQUEST_STATUS_OPTIONS = [
  { value: "pending", label: RESERVATION_STATUS_LABELS.pending },
  { value: "approved", label: RESERVATION_STATUS_LABELS.approved },
  { value: "rejected", label: RESERVATION_STATUS_LABELS.rejected },
  { value: "cancelled", label: RESERVATION_STATUS_LABELS.cancelled },
  { value: "expired", label: RESERVATION_STATUS_LABELS.expired },
] as const;

/** Non-active statuses shown on the 履歴 tab (removed is requested explicitly; the API hides it otherwise). */
export const HISTORY_STATUS_OPTIONS = [
  { value: "rejected", label: RESERVATION_STATUS_LABELS.rejected },
  { value: "cancelled", label: RESERVATION_STATUS_LABELS.cancelled },
  { value: "expired", label: RESERVATION_STATUS_LABELS.expired },
  { value: "removed", label: RESERVATION_STATUS_LABELS.removed },
] as const;

export const SLOT_STATE_OPTIONS = [
  { value: "open", label: SLOT_STATE_LABELS.open },
  { value: "closed", label: SLOT_STATE_LABELS.closed },
  { value: "cancelled", label: SLOT_STATE_LABELS.cancelled },
] as const;
