import type { ReactNode } from "react";
import {
  ATTENDANCE_LABELS,
  INVITATION_STATE_LABELS,
  OVERDUE_LABEL,
  PROGRESS_RECORD_STATE_LABELS,
  RESERVATION_STATUS_LABELS,
  SCAN_STATE_LABELS,
  SLOT_STATE_LABELS,
  UNIT_STATE_LABELS,
  VERSION_STATE_LABELS,
} from "@arms/contracts";
import { cn } from "./cn";

export type Tone = "info" | "success" | "warning" | "danger" | "neutral";

const tones: Record<Tone, string> = {
  info: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-neutral-soft text-muted",
};

/** Status chip — the text is always present so colour is never the only signal. */
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

const reservationTone: Record<keyof typeof RESERVATION_STATUS_LABELS, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
  expired: "neutral",
  removed: "neutral",
};
export function ReservationStatusBadge({ status }: { status: keyof typeof RESERVATION_STATUS_LABELS }) {
  return <Badge tone={reservationTone[status]}>{RESERVATION_STATUS_LABELS[status]}</Badge>;
}

const progressTone: Record<keyof typeof PROGRESS_RECORD_STATE_LABELS, Tone> = {
  unverified: "neutral",
  not_started: "neutral",
  in_progress: "info",
  review_pending: "warning",
  completed: "success",
};
export function ProgressStateBadge({ state, overdue }: { state: keyof typeof PROGRESS_RECORD_STATE_LABELS; overdue?: boolean }) {
  if (overdue) return <Badge tone="danger">{OVERDUE_LABEL}</Badge>;
  return <Badge tone={progressTone[state]}>{PROGRESS_RECORD_STATE_LABELS[state]}</Badge>;
}

export function UnitStateBadge({ state }: { state: keyof typeof UNIT_STATE_LABELS }) {
  return <Badge tone={progressTone[state]}>{UNIT_STATE_LABELS[state]}</Badge>;
}

export function ScanStateBadge({ state }: { state: keyof typeof SCAN_STATE_LABELS }) {
  const t: Tone = state === "clean" ? "success" : state === "blocked" ? "danger" : state === "pending" ? "warning" : "neutral";
  return <Badge tone={t}>{SCAN_STATE_LABELS[state]}</Badge>;
}

export function VersionStateBadge({ state }: { state: keyof typeof VERSION_STATE_LABELS }) {
  const t: Tone = state === "published" ? "success" : state === "draft" ? "info" : "neutral";
  return <Badge tone={t}>{VERSION_STATE_LABELS[state]}</Badge>;
}

export function SlotStateBadge({ state }: { state: keyof typeof SLOT_STATE_LABELS }) {
  const t: Tone = state === "open" ? "success" : state === "closed" ? "neutral" : "danger";
  return <Badge tone={t}>{SLOT_STATE_LABELS[state]}</Badge>;
}

export function AttendanceBadge({ state }: { state: keyof typeof ATTENDANCE_LABELS }) {
  const t: Tone = state === "present" ? "success" : state === "late" ? "warning" : state === "absent" ? "danger" : "neutral";
  return <Badge tone={t}>{ATTENDANCE_LABELS[state]}</Badge>;
}

export function InvitationBadge({ state }: { state: keyof typeof INVITATION_STATE_LABELS | null | undefined }) {
  if (!state) return null;
  const t: Tone = state === "sent" ? "success" : state === "failed" ? "danger" : "warning";
  return <Badge tone={t}>{INVITATION_STATE_LABELS[state]}</Badge>;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? "success" : "neutral"}>{active ? "有効" : "停止中"}</Badge>;
}
