/** Filter controls for the booking lists. Values come from and go to the URL (see filters.ts). */
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { addMonths, formatMonthJa } from "@arms/contracts";
import { fmt } from "../../lib/format";
import { FilterItem } from "../../components/ui/FilterBar";
import { Input, Select } from "../../components/ui/Field";
import { Button } from "../../components/ui/Button";
import { useClassroomOptions, useTeacherOptions } from "./api";
import type { Period, PeriodMode } from "./filters";

/** Text search committed to the URL 300 ms after typing stops. */
export function SearchFilter({ label, placeholder, value, onCommit }: { label: string; placeholder: string; value: string; onCommit(value: string): void }) {
  const [text, setText] = useState(value);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);
  useEffect(() => {
    setText((current) => (current.trim() === value ? current : value));
  }, [value]);
  useEffect(() => {
    const t = setTimeout(() => {
      const v = text.trim().slice(0, 100);
      if (v !== value) commit.current(v);
    }, 300);
    return () => clearTimeout(t);
  }, [text, value]);
  return (
    <FilterItem label={label}>
      {(id) => (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input id={id} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} maxLength={100} className="w-[220px] max-w-full pl-9" />
        </div>
      )}
    </FilterItem>
  );
}

const MODE_LABELS: Record<PeriodMode, string> = { upcoming: "今日以降", month: "月で指定", range: "日付で指定", all: "すべての期間" };

/** 期間: 今日以降 / 月で指定（前月・翌月） / 日付で指定（開始日・終了日） / すべての期間. */
export function PeriodFilter({ value, modes, onChange }: { value: Period; modes: readonly PeriodMode[]; onChange(p: Period): void }) {
  const thisMonth = fmt.today().slice(0, 7);
  return (
    <>
      <FilterItem label="期間">
        {(id) => (
          <Select
            id={id}
            value={value.mode}
            onChange={(e) => {
              const mode = e.target.value as PeriodMode;
              onChange(mode === "month" ? { mode, month: value.month ?? thisMonth } : mode === "range" ? { mode, from: value.from, to: value.to } : { mode });
            }}
          >
            {modes.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </Select>
        )}
      </FilterItem>
      {value.mode === "month" && value.month ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted" id="period-month-label">
            対象月
          </span>
          <div className="flex h-10 items-center gap-1" role="group" aria-labelledby="period-month-label">
            <Button variant="secondary" size="sm" aria-label="前の月" onClick={() => onChange({ mode: "month", month: addMonths(value.month!, -1) })}>
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <span className="min-w-[96px] text-center text-sm font-bold" aria-live="polite">
              {formatMonthJa(value.month)}
            </span>
            <Button variant="secondary" size="sm" aria-label="次の月" onClick={() => onChange({ mode: "month", month: addMonths(value.month!, 1) })}>
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
      {value.mode === "range" ? (
        <>
          <FilterItem label="開始日">
            {(id) => <Input id={id} type="date" value={value.from ?? ""} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value || undefined })} />}
          </FilterItem>
          <FilterItem label="終了日">
            {(id) => <Input id={id} type="date" value={value.to ?? ""} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value || undefined })} />}
          </FilterItem>
        </>
      ) : null}
    </>
  );
}

/** 担当講師 (admins only; a teacher's lists are already limited to their own lessons). */
export function TeacherFilter({ value, onChange }: { value: string | undefined; onChange(id: string | undefined): void }) {
  const teachers = useTeacherOptions(true);
  return (
    <FilterItem label="担当講師">
      {(id) => (
        <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} aria-busy={teachers.isLoading || undefined}>
          <option value="">すべて</option>
          {teachers.data?.items.map((t) => (
            <option key={t.id} value={t.id}>
              {t.display_name}
            </option>
          ))}
          {value && teachers.data && !teachers.data.items.some((t) => t.id === value) ? <option value={value}>（停止中または対象外の講師）</option> : null}
        </Select>
      )}
    </FilterItem>
  );
}

export function ClassroomFilter({ value, onChange }: { value: string | undefined; onChange(id: string | undefined): void }) {
  const classrooms = useClassroomOptions(true);
  return (
    <FilterItem label="クラス">
      {(id) => (
        <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} aria-busy={classrooms.isLoading || undefined}>
          <option value="">すべて</option>
          {classrooms.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {value && classrooms.data && !classrooms.data.items.some((c) => c.id === value) ? <option value={value}>（終了したクラス）</option> : null}
        </Select>
      )}
    </FilterItem>
  );
}
