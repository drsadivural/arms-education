import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface RadioOption<V extends string> {
  value: V;
  label: ReactNode;
}

/**
 * Segmented radio group built on native radio inputs (arrow keys move the selection, the legend names the group).
 * The selected option is bold with a check icon, so colour is never the only signal. `value` may be null when
 * nothing has been chosen yet (e.g. attendance not recorded).
 */
export function SegmentedRadioGroup<V extends string>({
  name,
  legend,
  legendHidden = false,
  options,
  value,
  onChange,
  disabled,
  className,
  describedBy,
}: {
  name: string;
  legend: ReactNode;
  legendHidden?: boolean;
  options: readonly RadioOption<V>[];
  value: V | null;
  onChange(value: V): void;
  disabled?: boolean;
  className?: string;
  describedBy?: string;
}) {
  return (
    <fieldset className={cn("min-w-0", className)} disabled={disabled} aria-describedby={describedBy}>
      <legend className={legendHidden ? "sr-only" : "mb-1.5 text-xs font-bold text-fg"}>{legend}</legend>
      <div className="inline-flex flex-wrap gap-1 rounded-[var(--radius-control)] border border-line bg-surface-2 p-1">
        {options.map((o) => {
          const checked = value === o.value;
          return (
            <label key={o.value} className="relative">
              <input type="radio" name={name} value={o.value} checked={checked} onChange={() => onChange(o.value)} className="peer sr-only" />
              <span
                className={cn(
                  "inline-flex h-8 min-w-12 cursor-pointer items-center justify-center gap-1 rounded-md px-3 text-xs whitespace-nowrap transition-colors",
                  "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-[var(--arms-focus)]",
                  "peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
                  checked ? "border border-primary bg-surface font-bold text-primary shadow-sm" : "border border-transparent text-muted hover:text-fg",
                )}
              >
                {checked ? <Check className="size-3.5" aria-hidden /> : null}
                {o.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
