import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { addDays, formatDateJa, weekdayOfDate } from "@arms/contracts";
import { Button } from "./Button";
import { cn } from "./cn";

/** Monday of the week containing `date` (YYYY-MM-DD, organisation-local calendar date). */
export function mondayOf(date: string): string {
  const wd = weekdayOfDate(date); // 0=日〜6=土
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

/** The seven dates (Monday start) of the week beginning at `monday`. */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Previous / this week / next week navigation with the visible range as text. */
export function WeekNavigator({ monday, today, onChange }: { monday: string; today: string; onChange(monday: string): void }) {
  const sunday = addDays(monday, 6);
  const isThisWeek = mondayOf(today) === monday;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" icon={<ChevronLeft className="size-4" aria-hidden />} onClick={() => onChange(addDays(monday, -7))}>
        前の週
      </Button>
      <Button variant="secondary" size="sm" disabled={isThisWeek} onClick={() => onChange(mondayOf(today))}>
        今週
      </Button>
      <Button variant="secondary" size="sm" onClick={() => onChange(addDays(monday, 7))}>
        次の週
        <ChevronRight className="size-4" aria-hidden />
      </Button>
      <p className="text-sm font-bold" aria-live="polite">
        {formatDateJa(monday, { withYear: true })}〜{formatDateJa(sunday)}
      </p>
    </div>
  );
}

/**
 * Week view (Monday start). Seven columns from 1024 px; on narrower screens each day becomes a stacked section.
 * Today is marked with the text 「今日」 (not only colour).
 */
export function WeekCalendar<T>({
  monday,
  today,
  items,
  dayOf,
  getKey,
  renderItem,
  emptyLabel,
  label,
}: {
  monday: string;
  today: string;
  items: readonly T[];
  dayOf(item: T): string;
  getKey(item: T): string;
  renderItem(item: T): ReactNode;
  emptyLabel: string;
  label: string;
}) {
  const days = weekDays(monday);
  return (
    <div role="group" aria-label={label} className="grid grid-cols-1 gap-3 lg:grid-cols-7">
      {days.map((day) => {
        const dayItems = items.filter((i) => dayOf(i) === day);
        const isToday = day === today;
        const headingId = `week-day-${day}`;
        return (
          <section
            key={day}
            aria-labelledby={headingId}
            className={cn("flex min-h-28 flex-col rounded-[var(--radius-control)] border bg-surface p-2", isToday ? "border-primary" : "border-line")}
          >
            <h3 id={headingId} className="mb-2 flex items-center justify-between gap-1 px-1 text-xs font-bold">
              <span>{formatDateJa(day)}</span>
              {isToday ? <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] text-primary">今日</span> : null}
            </h3>
            {dayItems.length === 0 ? (
              <p className="px-1 text-[11px] text-muted">{emptyLabel}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {dayItems.map((item) => (
                  <li key={getKey(item)}>{renderItem(item)}</li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
