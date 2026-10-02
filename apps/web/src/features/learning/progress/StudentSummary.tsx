import type { ReactNode } from "react";
import { cn } from "../../../components/ui/cn";

/** 研修サマリー header: initial avatar, name, affiliation line and a large progress bar (null → 未設定). */
export function StudentSummary({ name, meta, percent, footer }: { name: string; meta: ReactNode; percent: number | null | undefined; footer?: ReactNode }) {
  const v = percent === null || percent === undefined ? null : Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary-soft text-2xl font-bold text-primary">
          {name.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="text-xl font-bold break-words">{name}</p>
          <p className="mt-1 text-xs text-muted">{meta}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-label={`${name}さんの研修進捗`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={v ?? undefined}
          aria-valuetext={v === null ? "未設定" : `${v}%`}
          className="h-3 flex-1 overflow-hidden rounded-full bg-neutral-soft"
        >
          <div className={cn("h-full rounded-full bg-brand")} style={{ width: `${v ?? 0}%` }} />
        </div>
        <span className="w-20 text-right text-2xl font-bold tabular-nums">{v === null ? <span className="text-base text-muted">未設定</span> : `${v}%`}</span>
      </div>
      {footer ? <div className="text-xs text-muted">{footer}</div> : null}
    </div>
  );
}
