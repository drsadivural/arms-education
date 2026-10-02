/**
 * 出欠 (WEB-15 for past/ongoing lessons): roster of approved students with 出席/欠席/遅刻/公欠 and a note.
 * GET/POST /lesson-slots/{id}/attendance; admin or the slot's teacher. Recording opens 30 minutes before the start
 * (ATTENDANCE_NOT_OPEN before that). Saved records recompute progress on the server.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ATTENDANCE_LABELS, ERROR_CATALOG, type AttendanceState } from "@arms/contracts";
import { ApiError, api } from "../../lib/api";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { AttendanceBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { EmptyState, ErrorState, InlineError, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { Input } from "../../components/ui/Field";
import { SegmentedRadioGroup } from "../../components/ui/RadioGroup";
import { useToast } from "../../components/ui/Toast";
import { bookingKeys, useAttendance, type AttendanceRosterItem } from "./api";
import { dateTimeFull } from "./format";

const OPTIONS = (Object.keys(ATTENDANCE_LABELS) as AttendanceState[]).map((value) => ({ value, label: ATTENDANCE_LABELS[value] }));

interface Draft {
  state: AttendanceState | null;
  note: string;
}

export function AttendanceSection({ slotId }: { slotId: string }) {
  const query = useAttendance(slotId, true);
  const roster = query.data?.data;
  if (query.isLoading && !roster) {
    return (
      <Card>
        <CardHeader title="出欠" />
        <LoadingRows rows={3} label="出欠名簿を読み込み中です" />
      </Card>
    );
  }
  if (!roster) {
    return (
      <Card>
        <CardHeader title="出欠" />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }
  // Remount the editor when the server data changes so drafts start from the saved values.
  const version = roster.items.map((i) => `${i.student_id}:${i.attendance_state ?? ""}:${i.note}:${i.recorded_at ?? ""}`).join("|");
  return <AttendanceEditor key={version} slotId={slotId} items={roster.items} editable={roster.editable} checkedAt={query.data?.checked_at} />;
}

function AttendanceEditor({ slotId, items, editable, checkedAt }: { slotId: string; items: AttendanceRosterItem[]; editable: boolean; checkedAt?: string }) {
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const initial = useMemo(() => Object.fromEntries(items.map((i) => [i.student_id, { state: i.attendance_state, note: i.note } satisfies Draft])), [items]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(initial);
  const save = useIdempotentMutation<unknown, { records: { student_id: string; state: AttendanceState; note?: string }[] }>(
    (v, key) => api.post(`/lesson-slots/${encodeURIComponent(slotId)}/attendance`, v, { idempotencyKey: key }),
    { onSettled: () => qc.invalidateQueries({ queryKey: bookingKeys.attendance(slotId) }) },
  );
  const records = items
    .map((i) => ({ student_id: i.student_id, draft: drafts[i.student_id] }))
    .filter((r): r is { student_id: string; draft: { state: AttendanceState; note: string } } => !!r.draft?.state)
    .map((r) => ({ student_id: r.student_id, state: r.draft.state, ...(r.draft.note.trim() ? { note: r.draft.note.trim() } : {}) }));
  const dirty = items.some((i) => drafts[i.student_id]?.state !== i.attendance_state || (drafts[i.student_id]?.note ?? "") !== i.note);
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};

  const onSave = async () => {
    if (save.isPending || records.length === 0) return;
    try {
      await save.mutateAsync({ records });
      toast.success("出欠を保存しました", `${records.length}名の出欠を記録しました。`);
    } catch {
      // Shown inline below.
    }
  };

  return (
    <Card>
      <CardHeader
        title="出欠"
        description="承認済みの受講者の出欠を記録します。変更は操作履歴に残り、進捗の算出に使われます。"
        actions={<LastFetched checkedAt={checkedAt} />}
      />
      {!editable ? (
        <div className="mb-4">
          <Notice tone="warning">{ERROR_CATALOG.ATTENDANCE_NOT_OPEN.message_ja}</Notice>
        </div>
      ) : null}
      {items.length === 0 ? (
        <EmptyState title="承認済みの受講者はいません" description="予約が承認された受講者が出欠の対象になります。「予約申請」タブで申請を確認してください。" />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((i, index) => {
            const draft = drafts[i.student_id] ?? { state: null, note: "" };
            const err = fieldErrors[`records.${index}.student_id`] ?? fieldErrors[`records.${index}.note`];
            return (
              <li key={i.student_id} className="flex flex-col gap-3 py-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-bold">{i.student_name}</p>
                  <p className="text-xs text-muted">
                    社員番号 {i.employee_number}
                    {i.attendance_state ? (
                      <span className="ml-2 inline-flex items-center gap-1">
                        記録済み <AttendanceBadge state={i.attendance_state} />
                        {i.recorded_by_name ? `（${i.recorded_by_name}・${dateTimeFull(i.recorded_at)}）` : null}
                      </span>
                    ) : (
                      <span className="ml-2">未記録</span>
                    )}
                  </p>
                  {err ? (
                    <p role="alert" className="mt-1 text-xs text-danger">
                      {err}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2 lg:items-end">
                  <SegmentedRadioGroup
                    name={`attendance-${i.student_id}`}
                    legend={`${i.student_name}さんの出欠`}
                    legendHidden
                    options={OPTIONS}
                    value={draft.state}
                    disabled={!editable || !online}
                    onChange={(state) => setDrafts((d) => ({ ...d, [i.student_id]: { ...draft, state } }))}
                  />
                  <Input
                    aria-label={`${i.student_name}さんのメモ`}
                    placeholder="メモ（任意）"
                    value={draft.note}
                    maxLength={1000}
                    disabled={!editable || !online}
                    onChange={(e) => setDrafts((d) => ({ ...d, [i.student_id]: { ...draft, note: e.target.value } }))}
                    className="h-9 w-full lg:w-[320px]"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {save.error && Object.keys(fieldErrors).length === 0 ? (
        <div className="mt-3">
          <InlineError error={save.error} />
        </div>
      ) : null}
      {items.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {dirty ? <span className="text-xs text-warning">未保存の変更があります</span> : null}
          <Button loading={save.isPending} disabled={!editable || !online || records.length === 0 || !dirty} onClick={() => void onSave()}>
            出欠を保存
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
