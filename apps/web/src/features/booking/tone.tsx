/** Danger tone helpers for the booking screens (shared --arms-danger meets AA for small text on danger-soft). */
import type { RESERVATION_STATUS_LABELS } from "@arms/contracts";
import { ReservationStatusBadge } from "../../components/ui/Badge";

export const DANGER_TEXT = "text-danger";

const dangerChip = `inline-flex items-center rounded-md bg-danger-soft px-2 py-0.5 text-xs font-medium whitespace-nowrap ${DANGER_TEXT}`;

export function DangerChip({ children }: { children: string }) {
  return <span className={dangerChip}>{children}</span>;
}

/** Reservation status badge (shared component). */
export function BookingStatusBadge({ status }: { status: keyof typeof RESERVATION_STATUS_LABELS }) {
  return <ReservationStatusBadge status={status} />;
}

/** Soft red button (design: 「削除する」「授業を取消」) without stacking colour utilities on a shared variant. */
export const dangerSoftButton = `inline-flex h-10 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-danger/40 bg-danger-soft px-4 text-sm font-medium whitespace-nowrap ${DANGER_TEXT} hover:border-danger disabled:cursor-not-allowed disabled:opacity-55`;
