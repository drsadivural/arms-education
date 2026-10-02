/** WEB-13 tabs 「授業カレンダー」 (week view) and 「空き枠管理」 (slot list with 追加/編集/取消). */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { addDays, zonedDateString, type LessonSlot } from "@arms/contracts";
import type { QueryValue } from "../../lib/api";
import { ORG_TZ, fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useCurrentUser } from "../../lib/session";
import { Card, CardHeader } from "../../components/ui/Card";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { ErrorState, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { FilterBar } from "../../components/ui/FilterBar";
import { MultiSelectFilter } from "../../components/ui/MultiSelectFilter";
import { SlotStateBadge } from "../../components/ui/Badge";
import { WeekCalendar, WeekNavigator, mondayOf } from "../../components/ui/WeekCalendar";
import { cn } from "../../components/ui/cn";
import { useSlotList, useWeekSlots } from "./api";
import { ClassroomFilter, PeriodFilter, SearchFilter, TeacherFilter } from "./FilterControls";
import { periodLabel, periodQuery, readId, readList, readPeriod, readSearch, withParam, writePeriod } from "./filters";
import { SLOT_STATE_OPTIONS, dateTimeFull } from "./format";
import { useFilterParams } from "./ReservationTabs";
import { SlotCancelDialog } from "./SlotCancelDialog";
import { DANGER_TEXT, DangerChip } from "./tone";

/** Admins manage every slot; a teacher manages only the slots they teach (others in their classrooms are read-only). */
export function canManageSlot(slot: Pick<LessonSlot, "teacher_id" | "state">, user: { id: string; isAdmin: boolean }): boolean {
  return slot.state !== "cancelled" && (user.isAdmin || slot.teacher_id === user.id);
}

/** 「残席 3 / 定員 10」 (cancelled slots have no seats). */
export function seatsText(slot: LessonSlot): string {
  if (slot.state === "cancelled") return "取消済み";
  return `残席 ${slot.remaining} / 定員 ${slot.capacity}`;
}

function SlotCard({ slot }: { slot: LessonSlot }) {
  const full = slot.state !== "cancelled" && slot.remaining === 0;
  return (
    <Link
      to={`/bookings/slots/${slot.id}`}
      className={cn(
        "block rounded-[var(--radius-control)] border border-line p-2 text-xs hover:border-primary hover:bg-surface-2",
        slot.state === "cancelled" && "opacity-75",
      )}
    >
      <span className="block font-bold tabular-nums">
        {fmt.time(slot.starts_at)}–{fmt.time(slot.ends_at)}
      </span>
      <span className={cn("mt-0.5 block font-medium break-words", slot.state === "cancelled" && "line-through")}>{slot.title}</span>
      <span className="mt-0.5 block text-muted">{slot.classroom_name}</span>
      <span className="block text-muted">{slot.teacher_name}</span>
      <span className="mt-1 flex flex-wrap items-center gap-1">
        <SlotStateBadge state={slot.state} />
        {full ? <DangerChip>満席</DangerChip> : null}
      </span>
      <span className="mt-1 block">{seatsText(slot)}</span>
      {slot.pending_count ? <span className="block text-warning">承認待ち {slot.pending_count}件</span> : null}
    </Link>
  );
}

export function CalendarTab() {
  const user = useCurrentUser();
  const [sp, update] = useFilterParams();
  const today = fmt.today();
  const weekParam = sp.get("week");
  const monday = mondayOf(weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? weekParam : today);
  const sunday = addDays(monday, 6);
  const teacher = readId(sp, "teacher");
  const week = useWeekSlots(monday, sunday, teacher);
  return (
    <div className="flex flex-col gap-5">
      <FilterBar label="授業カレンダーの表示">
        <WeekNavigator monday={monday} today={today} onChange={(m) => update((p) => withParam(p, "week", m === mondayOf(today) ? null : m))} />
        {user.isAdmin ? <TeacherFilter value={teacher} onChange={(v) => update((p) => withParam(p, "teacher", v))} /> : null}
      </FilterBar>
      <Card>
        <CardHeader
          title="授業カレンダー"
          description="日本時間（JST）の週表示です。授業をクリックすると枠の詳細・編集を開きます。残席は承認待ち＋承認済みを差し引いた数です。"
          actions={<LastFetched checkedAt={week.data?.checked_at} />}
        />
        {week.isLoading && !week.data ? (
          <LoadingRows rows={4} label="授業カレンダーを読み込み中です" />
        ) : week.error && !week.data ? (
          <ErrorState error={week.error} onRetry={() => void week.refetch()} />
        ) : (
          <>
            {week.error ? <ErrorState compact error={week.error} onRetry={() => void week.refetch()} /> : null}
            <WeekCalendar
              monday={monday}
              today={today}
              items={week.data?.items ?? []}
              dayOf={(s) => zonedDateString(s.starts_at, ORG_TZ)}
              getKey={(s) => s.id}
              renderItem={(s) => <SlotCard slot={s} />}
              emptyLabel="授業はありません"
              label="週の授業"
            />
            {week.data && week.data.items.length === 0 ? (
              <p className="mt-4 text-center text-xs text-muted">
                この週の授業はありません。
                <Link to="/bookings/slots/new" className="ml-1 text-primary underline-offset-2 hover:underline">
                  予約枠を追加する
                </Link>
              </p>
            ) : null}
            {week.data?.truncated ? <p className="mt-3 text-xs text-warning">授業が多いため一部のみ表示しています。「空き枠管理」で期間を指定して確認してください。</p> : null}
          </>
        )}
      </Card>
    </div>
  );
}

const SLOT_STATE_VALUES = SLOT_STATE_OPTIONS.map((o) => o.value);

export function SlotsTab() {
  const user = useCurrentUser();
  const online = useOnline();
  const [sp, update] = useFilterParams();
  const q = readSearch(sp);
  const teacher = readId(sp, "teacher");
  const classroom = readId(sp, "classroom");
  const states = readList(sp, "status", SLOT_STATE_VALUES);
  const period = readPeriod(sp, "upcoming", ["upcoming", "month", "range"]);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const query: Record<string, QueryValue> = {
    q: q || undefined,
    teacher_id: teacher,
    classroom_id: classroom,
    status: states.length ? states.join(",") : undefined,
    // 「今日以降」 uses the API default window (lessons that have not ended yet).
    ...(period.mode === "upcoming" ? {} : periodQuery(period, fmt.today())),
  };
  const list = useSlotList(query);
  const rows = list.data?.pages.flatMap((p) => p.items);
  const cancelTarget = cancelId ? (rows?.find((s) => s.id === cancelId) ?? null) : null;
  const filtered = !!(q || teacher || classroom || states.length || period.mode !== "upcoming");

  const columns = useMemo<ColumnDef<LessonSlot, unknown>[]>(
    () => [
      {
        id: "title",
        header: "授業",
        cell: ({ row }) => (
          <Link to={`/bookings/slots/${row.original.id}`} className="font-medium text-primary underline-offset-2 hover:underline" title={row.original.title}>
            {row.original.title}
          </Link>
        ),
      },
      { id: "when", header: "日時", cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{fmt.slotRange(row.original.starts_at, row.original.ends_at)}</span> },
      { id: "classroom", header: "クラス", cell: ({ row }) => <span title={row.original.classroom_name}>{row.original.classroom_name}</span> },
      { id: "teacher", header: "講師", cell: ({ row }) => row.original.teacher_name },
      {
        id: "seats",
        header: "定員/残席",
        cell: ({ row }) =>
          row.original.state === "cancelled" ? (
            <span className="text-muted">—</span>
          ) : (
            <span className="tabular-nums">
              {row.original.capacity} / 残{row.original.remaining}
              {row.original.remaining === 0 ? <span className={`ml-1 text-xs font-medium ${DANGER_TEXT}`}>（満席）</span> : null}
            </span>
          ),
      },
      { id: "closes", header: "締切", cell: ({ row }) => <span className="whitespace-nowrap text-xs">{dateTimeFull(row.original.booking_closes_at)}</span> },
      { id: "state", header: "状態", cell: ({ row }) => <SlotStateBadge state={row.original.state} /> },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) => {
          const s = row.original;
          const context = <span className="sr-only">（{s.title} {fmt.slotRange(s.starts_at, s.ends_at)}）</span>;
          const base = "relative inline-flex min-h-8 items-center px-1 text-xs font-medium underline-offset-2 hover:underline";
          const link = `${base} text-primary`;
          if (!canManageSlot(s, user)) {
            return (
              <Link to={`/bookings/slots/${s.id}`} className={link}>
                詳細
                {context}
              </Link>
            );
          }
          return (
            <div className="relative flex flex-wrap items-center gap-2">
              <Link to={`/bookings/slots/${s.id}`} className={link}>
                編集
                {context}
              </Link>
              <Link to={`/bookings?slot=${s.id}&period=all`} className={link}>
                予約
                {context}
              </Link>
              <button type="button" className={`${base} ${DANGER_TEXT} disabled:opacity-50`} disabled={!online} onClick={() => setCancelId(s.id)}>
                取消
                {context}
              </button>
            </div>
          );
        },
      },
    ],
    [user, online],
  );

  return (
    <div className="flex flex-col gap-5">
      <FilterBar label="空き枠の絞り込み">
        <SearchFilter label="授業名で検索" placeholder="授業名" value={q} onCommit={(v) => update((p) => withParam(p, "q", v))} />
        <PeriodFilter
          value={period}
          modes={["upcoming", "month", "range"]}
          onChange={(v) =>
            update((p) => {
              writePeriod(p, v, "upcoming");
              return p;
            })
          }
        />
        <MultiSelectFilter label="状態" options={SLOT_STATE_OPTIONS} value={states} allLabel="取消以外" onChange={(v) => update((p) => withParam(p, "status", v))} />
        <ClassroomFilter value={classroom} onChange={(v) => update((p) => withParam(p, "classroom", v))} />
        {user.isAdmin ? <TeacherFilter value={teacher} onChange={(v) => update((p) => withParam(p, "teacher", v))} /> : null}
      </FilterBar>
      <Card>
        <CardHeader
          title="空き枠管理"
          description={`期間：${period.mode === "upcoming" ? "終了前の授業" : periodLabel(period)}。残席は承認待ち＋承認済みを差し引いた数です。`}
          actions={<LastFetched checkedAt={list.data?.pages[0]?.checked_at} />}
        />
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(s) => s.id}
          caption="授業・予約枠の一覧"
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          hasMore={!!list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={
            filtered
              ? { title: "条件に一致する授業枠はありません", description: "期間・状態・クラスの条件を変えて検索してください。" }
              : {
                  title: "今後の授業枠はまだありません",
                  description: "受講者が予約できるように、授業・予約枠を登録してください。",
                  action: (
                    <Link to="/bookings/slots/new" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
                      予約枠を追加する
                    </Link>
                  ),
                }
          }
        />
      </Card>
      <Notice>講師・クラスの時間重複はサーバーで検査されます。有効な予約がある授業は日時・講師・クラスの変更や定員の削減ができないため、「取消」で受講者へ通知してから新しい枠を作成してください。</Notice>
      <SlotCancelDialog key={cancelId ?? "none"} slot={cancelTarget} open={!!cancelId} onOpenChange={(o) => !o && setCancelId(null)} />
    </div>
  );
}
