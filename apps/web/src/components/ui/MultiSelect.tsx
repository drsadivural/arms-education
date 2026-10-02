import { useId, useState, type ReactNode } from "react";
import { cn } from "./cn";

export interface MultiSelectOption {
  value: string;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}

interface MultiSelectProps {
  legend: string;
  options: MultiSelectOption[];
  value: string[];
  onChange(next: string[]): void;
  error?: string;
  hint?: string;
  disabled?: boolean;
  /** Shows a filter box when there are more options than this. */
  searchThreshold?: number;
  emptyText?: string;
  className?: string;
}

/**
 * Multiple choice as a labelled checkbox group (fieldset/legend): keyboard and screen-reader friendly without a
 * custom listbox. Selected count is announced in the legend; long lists get a filter box and scroll.
 */
export function MultiSelect({ legend, options, value, onChange, error, hint, disabled, searchThreshold = 8, emptyText = "選択できる項目がありません", className }: MultiSelectProps) {
  const id = useId();
  const [filter, setFilter] = useState("");
  const selected = new Set(value);
  const term = filter.trim().toLowerCase();
  const visible = term ? options.filter((o) => o.label.toLowerCase().includes(term)) : options;
  const toggle = (v: string, on: boolean) => onChange(on ? [...value, v] : value.filter((x) => x !== v));
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-1.5", className)} aria-describedby={describedBy} disabled={disabled}>
      <legend className="mb-1.5 text-xs font-bold text-fg">
        {legend}
        <span className="ml-2 font-normal text-muted">（{value.length}件選択中）</span>
      </legend>
      {options.length > searchThreshold ? (
        <>
          <label htmlFor={`${id}-filter`} className="sr-only">
            {legend}を絞り込む
          </label>
          <input
            id={`${id}-filter`}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="名前で絞り込む"
            className="h-9 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm placeholder:text-muted"
          />
        </>
      ) : null}
      <div className={cn("max-h-56 overflow-y-auto rounded-[var(--radius-control)] border border-line bg-surface p-1", error && "border-danger")}>
        {visible.length === 0 ? <p className="px-2 py-3 text-xs text-muted">{options.length === 0 ? emptyText : "該当する項目がありません"}</p> : null}
        <ul className="flex flex-col">
          {visible.map((o) => (
            <li key={o.value}>
              <label className={cn("flex min-h-10 cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2", o.disabled && "cursor-not-allowed opacity-60")}>
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--arms-primary)]"
                  checked={selected.has(o.value)}
                  disabled={o.disabled}
                  onChange={(e) => toggle(o.value, e.target.checked)}
                />
                <span className="flex flex-col">
                  <span>{o.label}</span>
                  {o.description ? <span className="text-[11px] text-muted">{o.description}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
