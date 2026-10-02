/** Japanese labels for audit events / notification deliveries (WEB-19) and other admin display helpers. */
import type { OUTBOX_STATE_LABELS } from "@arms/contracts";
import { ADMIN_EVENT_LABELS, NOTIFICATION_DELIVERY_ERROR_LABELS, isOverdue } from "@arms/contracts";
import type { Tone } from "../../components/ui/Badge";

/** Every audit/outbox event type written by the API today (admin, auth, booking, notifications, account). */
export const EVENT_LABELS: Record<string, string> = {
  ...ADMIN_EVENT_LABELS,
  "account.deletion_requested": "本人削除申請",
  "lesson_slot.created": "授業枠の作成",
  "lesson_slot.updated": "授業枠の変更",
  "lesson_slot.cancelled": "授業枠の取消",
  "reservation.created": "予約申請",
  "reservation.approved": "予約の承認",
  "reservation.rejected": "予約の却下",
  "reservation.cancelled": "予約の取消",
  "reservation.expired": "予約申請の期限切れ",
  "reservation.removed": "予約の削除（履歴保持）",
  "attendance.recorded": "出欠の記録",
  "device.registered": "通知端末の登録",
  "device.unregistered": "通知端末の登録解除",
};

/** Event type prefixes offered in the 「イベント」 filter (the API matches event_type by prefix). */
export const EVENT_CATEGORIES: { value: string; label: string }[] = [
  { value: "auth.", label: "ログイン・認証" },
  { value: "teacher.", label: "講師" },
  { value: "student.", label: "新入社員" },
  { value: "classroom.", label: "クラス" },
  { value: "lesson_slot.", label: "授業枠" },
  { value: "reservation.", label: "予約" },
  { value: "attendance.", label: "出欠" },
  { value: "user.", label: "ユーザー管理" },
  { value: "invitation.", label: "招待メール" },
  { value: "account.", label: "本人削除申請" },
  { value: "settings.", label: "設定" },
  { value: "notification.", label: "通知" },
  { value: "device.", label: "通知端末" },
];

/** 「予約の承認」 for known types, otherwise the raw type so new events stay visible. */
export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

/** Result column: failures are recorded with a `.failed` suffix; other audit rows are committed operations. */
export function eventResult(type: string): { label: string; tone: Tone } {
  if (type.endsWith(".failed")) return { label: "失敗", tone: "danger" };
  if (type.endsWith(".retry_requested")) return { label: "再送待ち", tone: "warning" };
  return { label: "成功", tone: "success" };
}

const SUMMARY_KEYS = ["name", "display_name", "title", "slot_title", "employee_number", "teacher_number", "role", "event_type"] as const;

/** Short human readable target for the events table (from the redacted details). */
export function eventTarget(details: Record<string, unknown>, entityId: string | null, actorId: string | null = null): string {
  for (const key of SUMMARY_KEYS) {
    const v = details[key];
    if (typeof v === "string" && v) return key === "role" ? roleText(v) : v;
  }
  const after = details.after;
  if (after && typeof after === "object") {
    const t = (after as Record<string, unknown>).title;
    if (typeof t === "string" && t) return t;
  }
  if (entityId && entityId === actorId) return "本人";
  return entityId ? `ID ${entityId.slice(0, 8)}` : "—";
}

function roleText(role: string): string {
  return role === "admin" ? "管理者" : role === "teacher" ? "講師" : role === "student" ? "受講者" : role;
}

export const DELIVERY_STATE_TONES: Record<keyof typeof OUTBOX_STATE_LABELS, Tone> = {
  pending: "warning",
  processing: "info",
  delivered: "success",
  failed: "danger",
};

export function deliveryErrorLabel(code: string | null): string {
  if (!code) return "—";
  return (NOTIFICATION_DELIVERY_ERROR_LABELS as Record<string, string>)[code] ?? code;
}

/** Training status of a student derived from progress and the due date (JST today). */
export function trainingStatus(s: { progress_percent: number | null; training_due_on: string; active: boolean }, today: string): { label: string; tone: Tone } {
  if (!s.active) return { label: "在籍終了", tone: "neutral" };
  if (s.progress_percent === null) return { label: "プログラム未割当", tone: "neutral" };
  if (s.progress_percent >= 100) return { label: "完了", tone: "success" };
  if (isOverdue(s.training_due_on, today, false)) return { label: "期限超過", tone: "danger" };
  return { label: "受講中", tone: "info" };
}

/** Seconds ↔ hours/minutes for the settings form (stored in seconds by the API). */
export const toHours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
export const fromHours = (hours: number) => Math.round(hours * 3600);
export const toMinutes = (seconds: number) => Math.round((seconds / 60) * 100) / 100;
export const fromMinutes = (minutes: number) => Math.round(minutes * 60);
