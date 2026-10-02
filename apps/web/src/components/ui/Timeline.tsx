import type { ReactNode } from "react";

export interface TimelineItem {
  id: string;
  /** ISO instant (used for the <time> element). */
  at: string;
  /** Formatted time 「10月2日（金）11:20」. */
  atLabel: string;
  actor: string;
  title: ReactNode;
  body?: ReactNode;
}

/** Vertical history list (変更履歴): time, actor, what changed and why. Newest first as given. */
export function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-col gap-4 border-l-2 border-primary pl-5">
      {items.map((item) => (
        <li key={item.id} className="relative">
          <p className="text-sm font-bold">
            <time dateTime={item.at}>{item.atLabel}</time>
            <span className="ml-3">{item.actor}</span>
          </p>
          <div className="mt-1 text-sm">{item.title}</div>
          {item.body ? <div className="mt-1 text-xs text-muted">{item.body}</div> : null}
        </li>
      ))}
    </ol>
  );
}
