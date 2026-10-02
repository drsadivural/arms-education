import { Link } from "react-router";
import { addMonths, formatMonthJa } from "@arms/contracts";
import { cn } from "./cn";

const linkClass = "inline-flex min-h-10 items-center rounded-md px-2 text-sm text-primary hover:bg-primary-soft hover:underline";

/**
 * Month navigation of the legacy progress screen (assets/reference/legacy-progress.png): 前の6か月 / 先月 / 今月 /
 * 来月 / 次の6か月. Each control is a link (the month lives in the URL), so it works with the keyboard, history and
 * new tabs.
 */
export function MonthNavigator({ month, current, hrefFor, className }: { month: string; current: string; hrefFor(month: string): string; className?: string }) {
  return (
    <nav aria-label="表示月の切り替え" className={cn("grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr]", className)}>
      <div className="flex flex-wrap items-center gap-1">
        <Link className={linkClass} to={hrefFor(addMonths(month, -6))} aria-label={`前の6か月（${formatMonthJa(addMonths(month, -6))}）`}>
          ≪ 前の6か月
        </Link>
        <Link className={linkClass} to={hrefFor(addMonths(month, -1))} aria-label={`先月（${formatMonthJa(addMonths(month, -1))}）`}>
          ‹ 先月
        </Link>
      </div>
      <div className="flex items-center justify-center gap-3">
        <h2 className="text-xl font-bold tabular-nums" aria-live="polite">
          {formatMonthJa(month)}
        </h2>
        <Link className={cn(linkClass, "border border-line")} to={hrefFor(current)} aria-current={month === current ? "date" : undefined}>
          今月
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-1 sm:justify-end">
        <Link className={linkClass} to={hrefFor(addMonths(month, 1))} aria-label={`来月（${formatMonthJa(addMonths(month, 1))}）`}>
          来月 ›
        </Link>
        <Link className={linkClass} to={hrefFor(addMonths(month, 6))} aria-label={`次の6か月（${formatMonthJa(addMonths(month, 6))}）`}>
          次の6か月 ≫
        </Link>
      </div>
    </nav>
  );
}

/** Toggle chip for quick filters (今月の教育・来月の教育・部署). The pressed state is announced, not only coloured. */
export function QuickFilterChip({ pressed, onClick, children }: { pressed: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-10 items-center gap-1 rounded-[var(--radius-control)] border px-3 text-xs font-medium whitespace-nowrap",
        pressed ? "border-primary bg-primary-soft text-primary" : "border-line bg-surface text-fg hover:bg-surface-2",
      )}
    >
      {pressed ? <span aria-hidden>✓</span> : null}
      {children}
    </button>
  );
}
