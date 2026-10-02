/**
 * Booking status chips. They reuse the shared badges, except for the warning tone: the shared token pair
 * (--arms-warning #9a6700 on --arms-warning-soft #fff4d6) measures 4.44:1 at 10.5 px, just under WCAG AA, so the
 * light theme uses a darker amber (#8a5d00, 5.3:1) here until the shared token is adjusted.
 */
import { ATTENDANCE_LABELS, RESERVATION_STATUS_LABELS, type AttendanceState } from "@arms/contracts";
import { AttendanceBadge, ReservationStatusBadge } from "../../components/ui/Badge";

const warningChip = "inline-flex items-center rounded-md bg-warning-soft px-2 py-0.5 text-xs font-medium whitespace-nowrap text-[#8a5d00] dark:text-warning";

export function BookingStatusBadge({ status }: { status: keyof typeof RESERVATION_STATUS_LABELS }) {
  if (status === "pending") return <span className={warningChip}>{RESERVATION_STATUS_LABELS.pending}</span>;
  return <ReservationStatusBadge status={status} />;
}

export function BookingAttendanceBadge({ state }: { state: AttendanceState }) {
  if (state === "late") return <span className={warningChip}>{ATTENDANCE_LABELS.late}</span>;
  return <AttendanceBadge state={state} />;
}
