/** 「授業を取消」: POST /lesson-slots/{id}/cancel with a reason; active reservations are cancelled and students notified. */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isValidDecisionReason, type LessonSlot } from "@arms/contracts";
import { ApiError, api } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toast";
import { invalidateBooking } from "./api";
import { DecisionError, REASON_ERROR, ReasonField } from "./decisions";

interface CancelResult {
  success: boolean;
  checked_at: string;
  data?: { id?: string; state?: string; row_version?: number; cancelled_reservations?: number };
}

export function useCancelSlot() {
  const qc = useQueryClient();
  return useIdempotentMutation<CancelResult, { id: string; reason: string; expected_version: number }>(
    (v, key) => api.post<CancelResult>(`/lesson-slots/${encodeURIComponent(v.id)}/cancel`, { reason: v.reason, expected_version: v.expected_version }, { idempotencyKey: key }),
    { onSettled: () => invalidateBooking(qc) },
  );
}

export function SlotCancelDialog({ slot, open, onOpenChange }: { slot: LessonSlot | null; open: boolean; onOpenChange(open: boolean): void }) {
  const toast = useToast();
  const online = useOnline();
  const mutation = useCancelSlot();
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
  const confirm = async () => {
    if (!slot || mutation.isPending || !online) return;
    if (!isValidDecisionReason(reason)) {
      setFieldError(REASON_ERROR);
      return;
    }
    setFieldError(undefined);
    try {
      const res = await mutation.mutateAsync({ id: slot.id, reason: reason.trim(), expected_version: slot.row_version });
      const n = res.data?.cancelled_reservations ?? 0;
      toast.success("授業を取り消しました", n > 0 ? `${n}件の予約を取消済みにし、受講者へ通知しました。` : "有効な予約はありませんでした。");
      close(false);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.reason) setFieldError(err.fieldErrors.reason);
    }
  };
  const active = (slot?.pending_count ?? 0) + (slot?.approved_count ?? 0);
  return (
    <ConfirmDialog
      open={open && !!slot}
      onOpenChange={close}
      title="授業を取消"
      description={
        slot ? (
          <>
            <p className="font-bold">
              「{slot.title}」{fmt.slotRange(slot.starts_at, slot.ends_at)}（{slot.classroom_name}）を取り消します。
            </p>
            <p className="mt-1 text-xs text-muted">
              {active > 0
                ? `承認待ち${slot.pending_count ?? 0}件・承認済み${slot.approved_count ?? 0}件の予約はすべて取消済みになり、受講者に理由とともに通知されます。`
                : "この授業に有効な予約はありません。"}
              取り消した授業は元に戻せません。日時を変える場合は、取消後に新しい枠を作成してください。
            </p>
          </>
        ) : null
      }
      confirmLabel="授業を取消"
      loading={mutation.isPending}
      onConfirm={() => void confirm()}
    >
      <div className="flex flex-col gap-3">
        <ReasonField label="取消の理由" value={reason} onChange={setReason} error={fieldError} placeholder="受講者に通知する取消理由を入力してください" />
        <DecisionError error={mutation.error} />
        {!online ? <p className="text-xs text-warning">オフラインのため取り消せません。</p> : null}
      </div>
    </ConfirmDialog>
  );
}
