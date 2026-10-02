import { cn } from "./cn";

/** Progress bar with the percentage as text; null renders 「未設定」 (no units assigned). */
export function ProgressBar({ value, label, className }: { value: number | null | undefined; label?: string; className?: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted">未設定</span>;
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v}
        aria-label={label ?? "進捗"}
        className="h-1.5 w-24 overflow-hidden rounded-full bg-neutral-soft"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${v}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums">{v}%</span>
    </div>
  );
}
