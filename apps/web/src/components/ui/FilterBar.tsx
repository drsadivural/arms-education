import type { ReactNode } from "react";

/** Wrapping row of labelled filter controls. Filters are kept in the URL by the page (useSearchParams). */
export function FilterBar({ children, label = "絞り込み" }: { children: ReactNode; label?: string }) {
  return (
    <div role="search" aria-label={label} className="mb-5 flex flex-wrap items-end gap-3">
      {children}
    </div>
  );
}

export function FilterItem({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = `filter-${label.replace(/\s/g, "")}`;
  return (
    <div className="flex min-w-[150px] flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-muted">
        {label}
      </label>
      {children(id)}
    </div>
  );
}
