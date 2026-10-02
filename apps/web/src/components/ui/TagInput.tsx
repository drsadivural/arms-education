import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";

interface TagInputProps {
  id: string;
  value: string[];
  onChange(next: string[]): void;
  onBlur?(): void;
  placeholder?: string;
  maxTags?: number;
  maxLength?: number;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-required"?: boolean;
}

/**
 * Free-text tags (専門分野, 部署). Enter or 「、」「,」 adds the typed text, Backspace on an empty input removes the last
 * tag, and every tag has a labelled remove button. Duplicates and empty values are ignored.
 */
export function TagInput({ id, value, onChange, onBlur, placeholder, maxTags = 20, maxLength = 50, disabled, ...aria }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const full = value.length >= maxTags;

  const commit = (raw: string) => {
    const parts = raw
      .split(/[、,，\n]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) {
      if (next.length >= maxTags) break;
      if (!next.includes(p)) next.push(p.slice(0, maxLength));
    }
    onChange(next);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" || e.key === "," || e.key === "、") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5",
        aria["aria-invalid"] && "border-danger",
        disabled && "opacity-60",
      )}
    >
      <ul className="contents" aria-label="入力済みの項目">
        {value.map((tag) => (
          <li key={tag} className="inline-flex items-center gap-1 rounded-md bg-primary-soft py-0.5 pr-1 pl-2 text-xs text-fg">
            <span className="max-w-[16rem] truncate">{tag}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(value.filter((t) => t !== tag))}
              className="rounded p-0.5 text-muted hover:bg-surface hover:text-danger"
              aria-label={`${tag}を削除`}
            >
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <input
        id={id}
        value={draft}
        disabled={disabled || full}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (draft.trim()) commit(draft);
          onBlur?.();
        }}
        placeholder={full ? `最大${maxTags}件です` : placeholder}
        className="h-7 min-w-[8rem] flex-1 rounded bg-transparent px-1 text-sm text-fg placeholder:text-muted"
        {...aria}
      />
    </div>
  );
}
