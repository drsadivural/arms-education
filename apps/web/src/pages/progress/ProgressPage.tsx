import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { OVERDUE_LABEL, PROGRESS_RECORD_STATES, PROGRESS_RECORD_STATE_LABELS } from "@arms/contracts";
import { ProgressStateBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { Dialog } from "../../components/ui/Dialog";
import { LastFetched, Notice } from "../../components/ui/Feedback";
import { Select } from "../../components/ui/Field";
import { FilterBar, FilterItem } from "../../components/ui/FilterBar";
import { MonthNavigator, QuickFilterChip } from "../../components/ui/MonthNavigator";
import { PageHeader } from "../../components/ui/PageHeader";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { learningKeys, useClassroomsLookup, useDepartments, useTeachersLookup, type DataResponse, type ProgressRecord } from "../../features/learning/api";
import { currentMonth, dueDateLabel, monthShortLabel, progressColumnLabels, resolveMonth, shiftMonth } from "../../features/learning/format";
import { ExportControls } from "../../features/learning/progress/ExportControls";
import { ProgressRecordForm, type RecordFormValues } from "../../features/learning/progress/ProgressRecordForm";
import { SearchField } from "../../features/learning/SearchField";
import { useCursorList } from "../../features/learning/useCursorList";
import { useDiscardConfirm } from "../../features/learning/useDiscardConfirm";
import { useUrlParams } from "../../features/learning/useUrlParams";

const FILTER_KEYS = ["month", "department", "teacher_id", "classroom_id", "status", "q"] as const;
export const PROGRESS_PAGE_SIZE = 50;

const STATUS_OPTIONS = [...PROGRESS_RECORD_STATES.map((s) => ({ value: s, label: PROGRESS_RECORD_STATE_LABELS[s] })), { value: "overdue", label: OVERDUE_LABEL }];

/** 全N件 when every page is loaded; otherwise how many are shown and that more exist (the API returns no total). */
export function totalLabel(count: number, hasMore: boolean): string {
  return hasMore ? `${count}件を表示中（続きがあります）` : `全${count}件`;
}

function CreateRecordDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dirty, setDirty] = useState(false);
  const discard = useDiscardConfirm(dirty, () => onOpenChange(false));
  const create = useIdempotentMutation((body: RecordFormValues, key: string) => api.post<DataResponse<ProgressRecord>>("/progress-records", body, { idempotencyKey: key }));
  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && (o ? onOpenChange(o) : discard.requestClose())} title="教育記録を登録" description="既存システムと同じ項目（終了予定日・社員名・教育担当部署・教育担当者・内容）で登録します。" wide>
      <ProgressRecordForm
        record={null}
        submitting={create.isPending}
        submitError={create.error}
        onDirtyChange={setDirty}
        onCancel={discard.requestClose}
        onSubmit={async (values) => {
          const body = { ...values };
          delete body.correction_reason;
          const res = await create.mutateAsync(body).catch(() => null);
          if (!res) return;
          toast.success("教育記録を登録しました", `${res.data.student_name}さん・${dueDateLabel(res.data.due_date)}`);
          await qc.invalidateQueries({ queryKey: ["learning", "records"] });
          onOpenChange(false);
        }}
      />
      {discard.element}
    </Dialog>
  );
}

/** WEB-11 社員教育進捗管理: legacy-compatible progress records by month with filters, totals and CSV/PDF export. */
export function ProgressPage() {
  const online = useOnline();
  const [filters, setFilters] = useUrlParams(FILTER_KEYS);
  const [, setSearchParams] = useSearchParams();
  const thisMonth = currentMonth();
  const month = resolveMonth(filters.month);
  const viewYear = Number(month.slice(0, 4));
  /** Dates of another year than today's carry the year (legacy 2019 rows read 「2019年8月31日（土）」). */
  const currentYear = Number(thisMonth.slice(0, 4));
  const { departments } = useDepartments();
  const teachers = useTeachersLookup();
  const classrooms = useClassroomsLookup();
  const [creating, setCreating] = useState(false);

  const query = useMemo(
    () => ({
      month,
      department: filters.department || undefined,
      teacher_id: filters.teacher_id || undefined,
      classroom_id: filters.classroom_id || undefined,
      status: filters.status || undefined,
      q: filters.q || undefined,
    }),
    [month, filters.department, filters.teacher_id, filters.classroom_id, filters.status, filters.q],
  );
  const list = useCursorList<ProgressRecord>(learningKeys.records(query), "/progress-records", query, { limit: PROGRESS_PAGE_SIZE });

  const hrefFor = useCallback(
    (m: string) => {
      const p = new URLSearchParams();
      for (const k of FILTER_KEYS) if (k !== "month" && filters[k]) p.set(k, filters[k]);
      p.set("month", m);
      return `/progress?${p.toString()}`;
    },
    [filters],
  );
  const setMonth = (m: string) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("month", m);
      return next;
    });

  const columns = useMemo<ColumnDef<ProgressRecord, unknown>[]>(
    () => [
      { id: "due_date", header: progressColumnLabels.due_date, cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{dueDateLabel(row.original.due_date, currentYear)}</span> },
      {
        id: "student_name",
        header: progressColumnLabels.student_name,
        cell: ({ row }) => (
          <Link to={`/progress/students/${row.original.student_id}`} className="font-medium text-primary hover:underline" title={`社員番号 ${row.original.employee_number}`}>
            {row.original.student_name}
          </Link>
        ),
      },
      { id: "department_name", header: progressColumnLabels.department_name, cell: ({ row }) => row.original.department_name },
      { id: "teacher_name", header: progressColumnLabels.teacher_name, cell: ({ row }) => row.original.teacher_name },
      {
        id: "content",
        header: progressColumnLabels.content,
        cell: ({ row }) => (
          <span className="block max-w-[280px] truncate" title={row.original.content}>
            {row.original.content}
          </span>
        ),
      },
      { id: "progress", header: "進捗", cell: ({ row }) => <ProgressBar value={row.original.progress_percent} label={`${row.original.student_name}さんの研修進捗`} /> },
      { id: "state", header: "状態", cell: ({ row }) => <ProgressStateBadge state={row.original.state} overdue={row.original.overdue} /> },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) => {
          const r = row.original;
          const what = `${r.student_name}さん・${dueDateLabel(r.due_date, currentYear)}の記録`;
          return (
            <span className="relative flex gap-3 whitespace-nowrap">
              <Link to={`/progress/records/${r.id}`} className="text-primary hover:underline" aria-label={`${what}を閲覧`}>
                閲覧
              </Link>
              <Link to={`/progress/records/${r.id}?mode=edit`} className="text-primary hover:underline" aria-label={`${what}を編集`}>
                編集
              </Link>
            </span>
          );
        },
      },
    ],
    [currentYear],
  );

  const deptOptions = filters.department && !departments.includes(filters.department) ? [filters.department, ...departments] : departments;
  const filtered = !!(filters.department || filters.teacher_id || filters.classroom_id || filters.status || filters.q);

  return (
    <>
      <PageHeader
        title="社員教育進捗管理"
        crumbs={[{ label: "社員教育進捗管理" }]}
        actions={
          <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)} disabled={!online}>
            教育記録を登録
          </Button>
        }
      />
      <div role="group" aria-label="クイック絞り込み" className="mb-4 flex flex-wrap gap-2">
        <QuickFilterChip pressed={month === thisMonth} onClick={() => setMonth(thisMonth)}>
          今月の教育
        </QuickFilterChip>
        <QuickFilterChip pressed={month === shiftMonth(thisMonth, 1)} onClick={() => setMonth(shiftMonth(thisMonth, 1))}>
          来月の教育
        </QuickFilterChip>
        {departments.slice(0, 8).map((d) => (
          <QuickFilterChip key={d} pressed={filters.department === d} onClick={() => setFilters({ department: filters.department === d ? null : d })}>
            {d}担当
          </QuickFilterChip>
        ))}
      </div>
      <FilterBar label="教育記録の絞り込み">
        <FilterItem label="部署">
          {(id) => (
            <Select id={id} value={filters.department} onChange={(e) => setFilters({ department: e.target.value })}>
              <option value="">すべて</option>
              {deptOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
        <FilterItem label="担当講師">
          {(id) => (
            <Select id={id} value={filters.teacher_id} onChange={(e) => setFilters({ teacher_id: e.target.value })}>
              <option value="">すべて</option>
              {(teachers.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                  {t.active ? "" : "（停止中）"}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
        <FilterItem label="クラス">
          {(id) => (
            <Select id={id} value={filters.classroom_id} onChange={(e) => setFilters({ classroom_id: e.target.value })}>
              <option value="">すべて</option>
              {(classrooms.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
        <FilterItem label="状態">
          {(id) => (
            <Select id={id} value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}>
              <option value="">すべて</option>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
        <FilterItem label="検索（社員名・社員番号・内容）">
          {(id) => <SearchField id={id} value={filters.q} onCommit={(v) => setFilters({ q: v }, { replace: true })} />}
        </FilterItem>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters({ department: null, teacher_id: null, classroom_id: null, status: null, q: null })}>
            条件をクリア
          </Button>
        ) : null}
      </FilterBar>
      <MonthNavigator month={month} current={thisMonth} hrefFor={hrefFor} className="mb-4" />
      <Card aria-labelledby="records-heading">
        <CardHeader
          id="records-heading"
          title={`${monthShortLabel(month)}の教育記録`}
          description={viewYear !== Number(thisMonth.slice(0, 4)) ? `${viewYear}年の記録です。終了予定日は登録された年月日のまま表示しています。` : undefined}
          actions={<span className="text-[11px] text-muted">添付画面の項目を継承</span>}
        />
        <DataTable
          columns={columns}
          data={list.items}
          getRowId={(r) => r.id}
          caption={`${monthShortLabel(month)}の教育記録（${progressColumnLabels.due_date}順）`}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={list.refetch}
          hasMore={list.hasMore}
          loadingMore={list.loadingMore}
          onLoadMore={list.loadMore}
          empty={{
            title: filtered ? "条件に一致する教育記録はありません" : `${monthShortLabel(month)}に終了予定の教育記録はありません`,
            description: filtered ? "絞り込み条件を変更するか、別の月を表示してください。" : "前後の月を表示するか、「教育記録を登録」から追加してください。",
          }}
        />
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-t border-line pt-3">
          <div className="flex flex-col gap-1">
            <p className="text-xs" aria-live="polite">
              {list.items ? totalLabel(list.items.length, list.hasMore) : ""}
            </p>
            <LastFetched checkedAt={list.checkedAt} />
          </div>
          <ExportControls filters={query} />
        </div>
      </Card>
      <div className="mt-5">
        <Notice>終了予定日・社員名・教育担当部署・教育担当者・内容は、既存データを引き継いで管理できます。</Notice>
      </div>
      {creating ? <CreateRecordDialog open onOpenChange={setCreating} /> : null}
    </>
  );
}
