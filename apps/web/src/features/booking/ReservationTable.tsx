/**
 * Reservation table for WEB-13 予約申請 and 履歴. Row actions depend on the state (docs/04 transitions):
 *   承認待ち → 承認 / 却下 / 詳細 · 承認済み → 詳細 / 削除 · 却下・削除済み → 理由を見る / 詳細 · その他 → 詳細
 * The list is already scoped by the API (teacher: own lessons; admin: organisation), so every visible row may be decided.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Reservation } from "@arms/contracts";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { Button } from "../../components/ui/Button";
import { BookingStatusBadge } from "./badges";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { ReasonViewDialog, RejectDialog, RemoveDialog, useApproveAction } from "./decisions";
import { dateTimeFull } from "./format";

type DialogKind = "reject" | "remove" | "reason";

const linkClass = "inline-flex min-h-8 items-center px-1 text-xs font-medium text-primary underline-offset-2 hover:underline";

/** Hidden context so repeated buttons (承認, 却下, …) have distinct accessible names per row. */
function RowContext({ r }: { r: Reservation }) {
  return (
    <span className="sr-only">
      （{r.student_name} {fmt.slotRange(r.starts_at, r.ends_at)}）
    </span>
  );
}

export function ReservationTable({
  variant,
  rows,
  isLoading,
  error,
  onRetry,
  hasMore,
  loadingMore,
  onLoadMore,
  empty,
  caption,
}: {
  variant: "requests" | "history";
  rows: Reservation[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry(): void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  empty: { title: string; description?: ReactNode; action?: ReactNode };
  caption: string;
}) {
  const online = useOnline();
  const { approve, isPending } = useApproveAction();
  const [dialog, setDialog] = useState<{ kind: DialogKind; id: string } | null>(null);
  // Dialogs always act on the latest polled row (fresh row_version / status).
  const target = dialog ? (rows?.find((r) => r.id === dialog.id) ?? null) : null;

  const columns = useMemo<ColumnDef<Reservation, unknown>[]>(() => {
    const actions = (r: Reservation) => {
      const items: ReactNode[] = [];
      if (variant === "requests" && r.status === "pending") {
        items.push(
          <Button key="approve" size="sm" loading={isPending(r.id)} disabled={!online} onClick={() => void approve(r)}>
            承認
            <RowContext r={r} />
          </Button>,
          <Button key="reject" size="sm" variant="secondary" disabled={!online || isPending(r.id)} onClick={() => setDialog({ kind: "reject", id: r.id })}>
            却下
            <RowContext r={r} />
          </Button>,
        );
      }
      if (r.reason && (r.status === "rejected" || r.status === "removed" || r.status === "cancelled")) {
        items.push(
          <button key="reason" type="button" className={linkClass} onClick={() => setDialog({ kind: "reason", id: r.id })}>
            理由を見る
            <RowContext r={r} />
          </button>,
        );
      }
      items.push(
        <Link key="detail" to={`/bookings/reservations/${r.id}`} className={linkClass}>
          詳細
          <RowContext r={r} />
        </Link>,
      );
      if (variant === "requests" && r.status === "approved") {
        items.push(
          <button key="remove" type="button" className={`${linkClass} text-danger disabled:opacity-50`} disabled={!online} onClick={() => setDialog({ kind: "remove", id: r.id })}>
            削除
            <RowContext r={r} />
          </button>,
        );
      }
      return <div className="flex flex-wrap items-center gap-2">{items}</div>;
    };
    const cols: ColumnDef<Reservation, unknown>[] = [
      {
        id: "student",
        header: "受講者",
        cell: ({ row }) => (
          <span className="font-medium" title={row.original.employee_number ? `社員番号 ${row.original.employee_number}` : undefined}>
            {row.original.student_name ?? "—"}
          </span>
        ),
      },
      { id: "when", header: "希望日時", cell: ({ row }) => <span className="tabular-nums whitespace-nowrap">{fmt.slotRange(row.original.starts_at, row.original.ends_at)}</span> },
      { id: "lesson", header: "授業", cell: ({ row }) => <span title={row.original.slot_title}>{row.original.slot_title ?? "—"}</span> },
      { id: "teacher", header: "担当講師", cell: ({ row }) => row.original.teacher_name ?? "—" },
      { id: "status", header: "状態", cell: ({ row }) => <BookingStatusBadge status={row.original.status} /> },
    ];
    if (variant === "history") {
      cols.push(
        {
          id: "reason",
          header: "理由",
          cell: ({ row }) => (
            <span className="block max-w-[240px] truncate text-xs" title={row.original.reason ?? undefined}>
              {row.original.reason?.trim() ? row.original.reason : <span className="text-muted">記録なし</span>}
            </span>
          ),
        },
        { id: "updated", header: "更新日時", cell: ({ row }) => <span className="text-xs whitespace-nowrap">{dateTimeFull(row.original.updated_at)}</span> },
      );
    }
    cols.push({ id: "actions", header: "操作", cell: ({ row }) => actions(row.original) });
    return cols;
  }, [variant, online, approve, isPending]);

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        caption={caption}
        isLoading={isLoading}
        error={error}
        onRetry={onRetry}
        empty={empty}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />
      <RejectDialog key={`reject-${dialog?.id ?? ""}`} reservation={dialog?.kind === "reject" ? target : null} open={dialog?.kind === "reject"} onOpenChange={(o) => !o && setDialog(null)} />
      <RemoveDialog key={`remove-${dialog?.id ?? ""}`} reservation={dialog?.kind === "remove" ? target : null} open={dialog?.kind === "remove"} onOpenChange={(o) => !o && setDialog(null)} />
      <ReasonViewDialog reservation={dialog?.kind === "reason" ? target : null} open={dialog?.kind === "reason"} onOpenChange={(o) => !o && setDialog(null)} />
    </>
  );
}
