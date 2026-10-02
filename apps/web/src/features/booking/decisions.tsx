/**
 * Reservation decisions shared by WEB-13 (list) and WEB-14 (detail): approve, reject with a reason,
 * remove (soft delete, 「予約を削除し、履歴を保持します」) with a reason.
 *
 * - Every action sends expected_version and a stable Idempotency-Key per user action (useIdempotentMutation),
 *   so double clicks and network retries never act twice.
 * - Success is shown only after the API confirms; on RESERVATION_EXPIRED / VERSION_CONFLICT / INVALID_STATE the
 *   Japanese API message is shown and the views are refreshed so the row shows its real state.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent, type Ref } from "react";
import { RESERVATION_REMOVE_CONFIRM_JA, isValidDecisionReason, type Reservation } from "@arms/contracts";
import { ApiError, api, errorMessage } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { Textarea } from "../../components/ui/Field";
import { BookingStatusBadge, DANGER_TEXT } from "./tone";
import { useToast } from "../../components/ui/Toast";
import { bookingKeys, invalidateBooking } from "./api";
import { dateTimeFull } from "./format";

export type DecisionAction = "approve" | "reject" | "remove";

interface DecisionVars {
  id: string;
  expected_version: number;
  reason?: string;
}

/** Codes after which the shown row is stale: the views are refreshed automatically. */
const STALE_CODES = new Set(["RESERVATION_EXPIRED", "VERSION_CONFLICT", "INVALID_STATE", "NOT_FOUND"]);

export const REASON_ERROR = "理由を入力してください（1〜1,000文字）。";
export const REASON_MAX = 1000;

/** Japanese message for a failed decision, noting that the latest state has been loaded. */
export function decisionErrorMessage(error: unknown): string {
  const base = errorMessage(error);
  const requestId = error instanceof ApiError && error.status >= 500 ? error.requestId : null;
  const stale = error instanceof ApiError && STALE_CODES.has(error.code) ? " 最新の状態を表示しています。" : "";
  return `${base}${stale}${requestId ? `（問い合わせ番号: ${requestId}）` : ""}`;
}

/** POST /reservations/{id}/{approve|reject|remove} with expected_version + Idempotency-Key. */
export function useReservationDecision(action: DecisionAction) {
  const qc = useQueryClient();
  return useIdempotentMutation<Reservation, DecisionVars>(
    (v, key) =>
      api.post<Reservation>(
        `/reservations/${encodeURIComponent(v.id)}/${action}`,
        { expected_version: v.expected_version, ...(v.reason ? { reason: v.reason } : {}) },
        { idempotencyKey: key },
      ),
    {
      onSuccess: (r) => {
        qc.setQueryData<Reservation>(bookingKeys.reservation(r.id), (old) => (old ? { ...old, ...r, history: old.history } : old));
      },
      onSettled: () => invalidateBooking(qc),
    },
  );
}

export function reservationCaption(r: Reservation): string {
  return `${r.student_name ?? "受講者"}さん・${r.slot_title ?? "授業"} ${fmt.slotRange(r.starts_at, r.ends_at)}`;
}

/** Approve straight from a list/detail button; guards against a second click while the first is in flight. */
export function useApproveAction() {
  const toast = useToast();
  const mutation = useReservationDecision("approve");
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<readonly string[]>([]);
  const approve = async (r: Reservation): Promise<boolean> => {
    if (inFlight.current.has(r.id)) return false;
    inFlight.current.add(r.id);
    setPending([...inFlight.current]);
    try {
      await mutation.mutateAsync({ id: r.id, expected_version: r.row_version });
      toast.success("予約を承認しました", reservationCaption(r));
      return true;
    } catch (e) {
      toast.error("承認できませんでした", decisionErrorMessage(e));
      return false;
    } finally {
      inFlight.current.delete(r.id);
      setPending([...inFlight.current]);
    }
  };
  return { approve, isPending: (id: string) => pending.includes(id) };
}

/** Alert for a failed decision (Japanese API message + refresh note + request id for server errors). */
export function DecisionError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className={`rounded-[var(--radius-control)] border border-danger/40 bg-danger-soft px-3 py-2 text-xs ${DANGER_TEXT}`}>
      {decisionErrorMessage(error)}
    </div>
  );
}

/** Target of a decision dialog, stated explicitly (docs/03 「削除/取消/却下は対象と結果を明示」). */
export function ReservationSummary({ reservation: r }: { reservation: Reservation }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-[var(--radius-control)] bg-surface-2 p-3 text-xs">
      <dt className="text-muted">受講者</dt>
      <dd className="font-bold">{r.student_name ?? "—"}</dd>
      <dt className="text-muted">授業</dt>
      <dd>{r.slot_title ?? "—"}</dd>
      <dt className="text-muted">日時</dt>
      <dd>{fmt.slotRange(r.starts_at, r.ends_at)}</dd>
      <dt className="text-muted">担当講師</dt>
      <dd>{r.teacher_name ?? "—"}</dd>
      <dt className="text-muted">現在の状態</dt>
      <dd>
        <BookingStatusBadge status={r.status} />
      </dd>
    </dl>
  );
}

/** Reason textarea with a live character count and the Japanese error. */
export function ReasonField({
  label,
  value,
  onChange,
  error,
  placeholder = "受講者に伝える理由を入力してください",
  autoFocus,
  textareaRef,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  error?: string;
  placeholder?: string;
  autoFocus?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  const length = value.trim().length;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-bold">
        {label}
        <span className="ml-1 text-danger" aria-hidden>
          *
        </span>
        <span className="sr-only">（必須）</span>
      </label>
      <Textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={REASON_MAX + 200}
        rows={4}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-required
        aria-describedby={`${id}-count${error ? ` ${id}-error` : ""}`}
        autoFocus={autoFocus}
      />
      <p id={`${id}-count`} className={length > REASON_MAX ? "text-xs text-danger" : "text-xs text-muted"}>
        {length} / {REASON_MAX.toLocaleString("ja-JP")}文字
      </p>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 却下: requires a reason (1〜1,000 characters); the dialog stays open with the error when the API refuses. */
export function RejectDialog({ reservation, open, onOpenChange }: { reservation: Reservation | null; open: boolean; onOpenChange(open: boolean): void }) {
  const toast = useToast();
  const online = useOnline();
  const mutation = useReservationDecision("reject");
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const close = (next: boolean) => {
    if (!next) {
      setReason("");
      setFieldError(undefined);
      mutation.reset();
    }
    onOpenChange(next);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reservation || mutation.isPending) return;
    if (!isValidDecisionReason(reason)) {
      setFieldError(REASON_ERROR);
      return;
    }
    setFieldError(undefined);
    try {
      await mutation.mutateAsync({ id: reservation.id, expected_version: reservation.row_version, reason: reason.trim() });
      toast.success("予約申請を却下しました", reservationCaption(reservation));
      close(false);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.reason) setFieldError(err.fieldErrors.reason);
    }
  };
  return (
    <Dialog open={open && !!reservation} onOpenChange={close} title="予約申請を却下" description="却下の理由は受講者のアプリと通知に表示されます。">
      {reservation ? (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <ReservationSummary reservation={reservation} />
          <ReasonField label="却下の理由" value={reason} onChange={setReason} error={fieldError} autoFocus />
          <DecisionError error={mutation.error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => close(false)} disabled={mutation.isPending}>
              キャンセル
            </Button>
            <Button type="submit" variant="danger" loading={mutation.isPending} disabled={!online}>
              却下する
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

/** 削除: soft delete to 「削除済み」 with a required reason; the history and audit log are kept. */
export function RemoveDialog({
  reservation,
  open,
  onOpenChange,
  initialReason = "",
  onRemoved,
}: {
  reservation: Reservation | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  initialReason?: string;
  onRemoved?(): void;
}) {
  const toast = useToast();
  const online = useOnline();
  const mutation = useReservationDecision("remove");
  const [reason, setReason] = useState(initialReason);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  // Re-seed the reason each time the dialog opens (e.g. from the detail page's shared reason field).
  if (open && openedWith === null) {
    setOpenedWith(initialReason);
    setReason(initialReason);
  }
  const close = (next: boolean) => {
    if (!next) {
      setOpenedWith(null);
      setReason("");
      setFieldError(undefined);
      mutation.reset();
    }
    onOpenChange(next);
  };
  const confirm = async () => {
    if (!reservation || mutation.isPending) return;
    if (!isValidDecisionReason(reason)) {
      setFieldError(REASON_ERROR);
      return;
    }
    setFieldError(undefined);
    try {
      await mutation.mutateAsync({ id: reservation.id, expected_version: reservation.row_version, reason: reason.trim() });
      toast.success("予約を削除しました", "履歴は保持され、「履歴」タブで確認できます。");
      close(false);
      onRemoved?.();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.reason) setFieldError(err.fieldErrors.reason);
    }
  };
  return (
    <ConfirmDialog
      open={open && !!reservation}
      onOpenChange={close}
      title="予約を削除"
      description={
        <>
          <p className="font-bold">{RESERVATION_REMOVE_CONFIRM_JA}。</p>
          <p className="mt-1 text-xs text-muted">削除した予約は通常の一覧に表示されなくなり、席が解放されます。操作履歴と理由は「履歴」に残り、受講者に通知されます。</p>
        </>
      }
      confirmLabel="削除する"
      loading={mutation.isPending}
      onConfirm={() => {
        if (online) void confirm();
      }}
    >
      {reservation ? (
        <div className="flex flex-col gap-4">
          <ReservationSummary reservation={reservation} />
          <ReasonField label="削除の理由" value={reason} onChange={setReason} error={fieldError} />
          <DecisionError error={mutation.error} />
          {!online ? <p className="text-xs text-warning">オフラインのため削除できません。</p> : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

/** 理由を見る: the recorded reason of a rejected/cancelled/removed reservation. */
export function ReasonViewDialog({ reservation, open, onOpenChange }: { reservation: Reservation | null; open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open && !!reservation} onOpenChange={onOpenChange} title="理由" description="予約の判断・取消時に記録された理由です。">
      {reservation ? (
        <div className="flex flex-col gap-4">
          <ReservationSummary reservation={reservation} />
          <div>
            <p className="text-xs text-muted">理由（{dateTimeFull(reservation.updated_at)} 更新）</p>
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">{reservation.reason?.trim() ? reservation.reason : "理由は記録されていません。"}</p>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              閉じる
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
