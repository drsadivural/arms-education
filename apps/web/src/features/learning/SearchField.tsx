import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "../../components/ui/Field";

/**
 * Search box bound to a URL parameter: typing updates the URL after a short pause (replace, no history spam);
 * Enter commits immediately. External URL changes (back button) are reflected in the box.
 */
export function SearchField({ id, value, onCommit, placeholder }: { id: string; value: string; onCommit(v: string): void; placeholder?: string }) {
  const [text, setText] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text.trim() === committed.current) return;
    const t = setTimeout(() => {
      committed.current = text.trim();
      onCommit(text.trim());
    }, 400);
    return () => clearTimeout(t);
  }, [text, onCommit]);
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <Input
        id={id}
        type="search"
        className="pl-9"
        value={text}
        placeholder={placeholder}
        maxLength={100}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            committed.current = text.trim();
            onCommit(text.trim());
          }
        }}
      />
    </div>
  );
}
