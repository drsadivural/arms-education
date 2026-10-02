/**
 * Danger tone for small text on the booking screens. The shared light token --arms-danger (#c93843) is 4.46:1 on
 * --arms-danger-soft (#fdecee), just under WCAG AA for the 10.5 px badge text, so light mode uses #b8303b
 * (5.22:1 on danger-soft, 5.96:1 on white) here. Dark mode keeps the shared token. Remove once the shared token is
 * darkened (requested in the booking report).
 */
import { RESERVATION_STATUS_LABELS } from "@arms/contracts";
import { ReservationStatusBadge } from "../../components/ui/Badge";

export const DANGER_TEXT = "text-[#b8303b] dark:text-danger";

const dangerChip = `inline-flex items-center rounded-md bg-danger-soft px-2 py-0.5 text-xs font-medium whitespace-nowrap ${DANGER_TEXT}`;

export function DangerChip({ children }: { children: string }) {
  return <span className={dangerChip}>{children}</span>;
}

/** Shared ReservationStatusBadge, except 却下 which uses the compliant danger text. */
export function BookingStatusBadge({ status }: { status: keyof typeof RESERVATION_STATUS_LABELS }) {
  if (status === "rejected") return <DangerChip>{RESERVATION_STATUS_LABELS.rejected}</DangerChip>;
  return <ReservationStatusBadge status={status} />;
}

/** Soft red button (design: 「削除する」「授業を取消」) without stacking colour utilities on a shared variant. */
export const dangerSoftButton = `inline-flex h-10 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-danger/40 bg-danger-soft px-4 text-sm font-medium whitespace-nowrap ${DANGER_TEXT} hover:border-danger disabled:cursor-not-allowed disabled:opacity-55`;
