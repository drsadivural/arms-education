import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { cn } from "./cn";

export interface MultiSelectOption<V extends string> {
  value: V;
  label: string;
}

/**
 * Filter that selects several values (e.g. 状態: 承認待ち・承認済み) from a popover of checkboxes.
 * An empty selection means 「すべて」. The trigger's accessible name includes the label and the current selection.
 */
export function MultiSelectFilter<V extends string>({
  label,
  options,
  value,
  onChange,
  allLabel = "すべて",
  className,
}: {
  label: string;
  options: readonly MultiSelectOption<V>[];
  value: readonly V[];
  onChange(value: V[]): void;
  allLabel?: string;
  className?: string;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const selected = options.filter((o) => value.includes(o.value));
  const summary = selected.length === 0 || selected.length === options.length ? allLabel : selected.map((o) => o.label).join("・");
  const toggle = (v: V, on: boolean) => {
    const next = on ? [...value, v] : value.filter((x) => x !== v);
    // Keep the option order stable in the URL.
    onChange(options.map((o) => o.value).filter((x) => next.includes(x)));
  };
  return (
    <div className={cn("flex min-w-[150px] flex-col gap-1", className)}>
      <span id={labelId} className="text-[11px] text-muted">
        {label}
      </span>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-labelledby={`${labelId} ${valueId}`}
            className="flex h-10 w-full items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-left text-sm text-fg"
          >
            <span id={valueId} className="truncate">
              {summary}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} className="z-50 min-w-[220px] rounded-[var(--radius-control)] border border-line bg-surface p-2 shadow-lg">
            <fieldset>
              <legend className="px-2 pb-1 text-[11px] text-muted">{label}（複数選択可）</legend>
              {options.map((o) => (
                <label key={o.value} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--arms-primary)]"
                    checked={value.includes(o.value)}
                    onChange={(e) => toggle(o.value, e.target.checked)}
                  />
                  {o.label}
                </label>
              ))}
            </fieldset>
            <div className="mt-1 border-t border-line pt-1">
              <button type="button" className="w-full rounded-md px-2 py-2 text-left text-xs text-primary hover:bg-surface-2" onClick={() => onChange([])}>
                選択を解除（{allLabel}）
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
