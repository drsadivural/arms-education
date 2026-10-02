/** WEB-13 tabs 「予約申請」 and 「履歴」: URL filters + live reservation list. */
import { X } from "lucide-react";
import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";
import type { QueryValue } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useCurrentUser } from "../../lib/session";
import { Card, CardHeader } from "../../components/ui/Card";
import { FilterBar } from "../../components/ui/FilterBar";
import { LastFetched, Notice } from "../../components/ui/Feedback";
import { MultiSelectFilter } from "../../components/ui/MultiSelectFilter";
import { useReservationList, useSlot } from "./api";
import { PeriodFilter, SearchFilter, TeacherFilter } from "./FilterControls";
import { periodLabel, periodQuery, readId, readList, readPeriod, readSearch, withParam, writePeriod, type Period, type PeriodMode } from "./filters";
import { HISTORY_STATUS_OPTIONS, REQUEST_STATUS_OPTIONS } from "./format";
import { ReservationTable } from "./ReservationTable";

const REQUEST_STATUSES = REQUEST_STATUS_OPTIONS.map((o) => o.value);
const HISTORY_STATUSES = HISTORY_STATUS_OPTIONS.map((o) => o.value);

/** Search params with an updater that replaces the history entry (filters should not flood the back button). */
export function useFilterParams() {
  const [sp, setSp] = useSearchParams();
  const update = useCallback((fn: (sp: URLSearchParams) => URLSearchParams) => setSp((prev) => fn(new URLSearchParams(prev)), { replace: true }), [setSp]);
  return [sp, update] as const;
}

function useReservationFilters(defaultPeriod: PeriodMode) {
  const [sp, update] = useFilterParams();
  const q = readSearch(sp);
  const teacher = readId(sp, "teacher");
  const period = readPeriod(sp, defaultPeriod);
  const setQ = useCallback((v: string) => update((p) => withParam(p, "q", v)), [update]);
  const setTeacher = (v: string | undefined) => update((p) => withParam(p, "teacher", v));
  const setPeriod = (v: Period) =>
    update((p) => {
      writePeriod(p, v, defaultPeriod);
      return p;
    });
  return { sp, update, q, teacher, period, setQ, setTeacher, setPeriod };
}

export function RequestsTab() {
  const user = useCurrentUser();
  const { sp, update, q, teacher, period, setQ, setTeacher, setPeriod } = useReservationFilters("upcoming");
  const statuses = readList(sp, "status", REQUEST_STATUSES);
  const slotId = readId(sp, "slot");
  const slot = useSlot(slotId);
  const query: Record<string, QueryValue> = {
    q: q || undefined,
    status: statuses.length ? statuses.join(",") : undefined,
    teacher_id: teacher,
    slot_id: slotId,
    ...periodQuery(period, fmt.today()),
    sort: period.mode === "all" ? "-starts_at" : "starts_at",
  };
  const list = useReservationList(query);
  const rows = list.data?.pages.flatMap((p) => p.items);
  const filtered = !!(q || statuses.length || teacher || slotId || period.mode !== "upcoming");

  return (
    <div className="flex flex-col gap-5">
      <FilterBar label="予約申請の絞り込み">
        <SearchFilter label="申請者で検索" placeholder="氏名・社員番号" value={q} onCommit={setQ} />
        <PeriodFilter value={period} modes={["upcoming", "month", "range", "all"]} onChange={setPeriod} />
        <MultiSelectFilter label="状態" options={REQUEST_STATUS_OPTIONS} value={statuses} onChange={(v) => update((p) => withParam(p, "status", v))} />
        {user.isAdmin ? <TeacherFilter value={teacher} onChange={setTeacher} /> : null}
      </FilterBar>
      {slotId ? (
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-primary-soft px-3 py-1 text-primary">
            授業で絞り込み中：{slot.data ? `${slot.data.data.title} ${fmt.slotRange(slot.data.data.starts_at, slot.data.data.ends_at)}` : "読み込み中"}
          </span>
          <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-primary hover:bg-surface-2" onClick={() => update((p) => withParam(p, "slot", null))}>
            <X className="size-3.5" aria-hidden />
            授業の絞り込みを解除
          </button>
        </div>
      ) : null}
      <Card>
        <CardHeader
          title="予約申請と承認"
          description={`期間：${periodLabel(period)}`}
          actions={
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-[11px] text-muted">iOS・Web・音声と同期</span>
              <LastFetched checkedAt={list.data?.pages[0]?.checked_at} />
            </div>
          }
        />
        <ReservationTable
          variant="requests"
          caption="予約申請の一覧"
          rows={rows}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          hasMore={!!list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={
            filtered
              ? { title: "条件に一致する予約申請はありません", description: "期間や状態の条件を変えて検索してください。" }
              : {
                  title: "今日以降の予約申請はまだありません",
                  description: "受講者がiOSアプリから空き枠を申請すると、ここに表示されます。まず授業・予約枠を登録してください。",
                  action: (
                    <Link to="/bookings/slots/new" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
                      予約枠を追加する
                    </Link>
                  ),
                }
          }
        />
      </Card>
      <Notice>承認待ちの申請も、保持期限までは席を確保します。却下・取消・削除・期限切れで席が解放されます。</Notice>
    </div>
  );
}

export function HistoryTab() {
  const user = useCurrentUser();
  const { sp, update, q, teacher, period, setQ, setTeacher, setPeriod } = useReservationFilters("all");
  const statuses = readList(sp, "status", HISTORY_STATUSES);
  const query: Record<string, QueryValue> = {
    q: q || undefined,
    // 削除済み is only returned when requested explicitly, so the default asks for every non-active state.
    status: (statuses.length ? statuses : HISTORY_STATUSES).join(","),
    teacher_id: teacher,
    ...periodQuery(period, fmt.today()),
    sort: "-starts_at",
  };
  const list = useReservationList(query);
  const rows = list.data?.pages.flatMap((p) => p.items);
  const filtered = !!(q || statuses.length || teacher || period.mode !== "all");
  return (
    <div className="flex flex-col gap-5">
      <FilterBar label="履歴の絞り込み">
        <SearchFilter label="申請者で検索" placeholder="氏名・社員番号" value={q} onCommit={setQ} />
        <PeriodFilter value={period} modes={["all", "upcoming", "month", "range"]} onChange={setPeriod} />
        <MultiSelectFilter label="状態" options={HISTORY_STATUS_OPTIONS} value={statuses} onChange={(v) => update((p) => withParam(p, "status", v))} />
        {user.isAdmin ? <TeacherFilter value={teacher} onChange={setTeacher} /> : null}
      </FilterBar>
      <Card>
        <CardHeader
          title="予約の履歴"
          description="却下・取消・申請期限切れ・削除済みの予約と理由。削除済みの予約も履歴として保持されます。"
          actions={<LastFetched checkedAt={list.data?.pages[0]?.checked_at} />}
        />
        <ReservationTable
          variant="history"
          caption="予約の履歴"
          rows={rows}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          hasMore={!!list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={
            filtered
              ? { title: "条件に一致する履歴はありません", description: "期間や状態の条件を変えて検索してください。" }
              : { title: "履歴はまだありません", description: "却下・取消・期限切れ・削除された予約がここに表示されます。" }
          }
        />
      </Card>
    </div>
  );
}
