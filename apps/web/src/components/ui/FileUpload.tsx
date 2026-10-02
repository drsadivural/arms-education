import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { UploadCloud } from "lucide-react";
import { Button } from "./Button";
import { cn } from "./cn";

/**
 * Keyboard-accessible file picker with a drag-and-drop area (the button is the primary control; dropping is a
 * convenience). The caller validates and uploads the chosen file.
 */
export function FileDropZone({
  title,
  description,
  hint,
  accept,
  disabled,
  buttonLabel = "ファイルを選択",
  onFile,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  hint?: ReactNode;
  accept?: string;
  disabled?: boolean;
  buttonLabel?: string;
  onFile(file: File): void;
  className?: string;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const id = useId();
  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onFile(file);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) pick(e.dataTransfer.files);
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-line px-4 py-6 text-center",
        over ? "border-primary bg-primary-soft" : "bg-surface-2",
        disabled && "opacity-60",
        className,
      )}
    >
      <UploadCloud className="size-6 text-muted" aria-hidden />
      <p id={`${id}-title`} className="text-sm font-bold">
        {title}
      </p>
      {description ? <p className="text-xs text-muted">{description}</p> : null}
      <input
        ref={inputRef}
        id={`${id}-input`}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      <Button variant="secondary" size="sm" disabled={disabled} aria-describedby={`${id}-title`} onClick={() => inputRef.current?.click()}>
        {buttonLabel}
      </Button>
      {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
      {children}
    </div>
  );
}

/** Upload progress with the percentage as text (never colour only). */
export function UploadProgress({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className="flex w-full max-w-sm items-center gap-2">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-soft">
        <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right text-xs font-bold tabular-nums">{pct}%</span>
    </div>
  );
}
