import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Page } from "@arms/contracts";
import { Input, Select } from "../../components/ui/Field";
import { api } from "../../lib/api";
import type { Student } from "./api";

export interface PickedStudent {
  id: string;
  display_name: string;
  employee_number: string;
  department_name: string;
  teacher_id: string;
}

/**
 * Student selection for forms: search by 社員名・社員番号 (GET /students, teacher scope applied by the API), then
 * choose from the matching list. Homonyms are told apart by the employee number.
 */
export function StudentPicker({
  value,
  selectedLabel,
  onChange,
  label,
  required,
  error,
  disabled,
  activeOnly,
}: {
  value: string;
  selectedLabel?: string;
  onChange(student: PickedStudent | null): void;
  label: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  activeOnly?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const results = useQuery({
    queryKey: ["lookup", "students", q, activeOnly ? "active" : "all"],
    queryFn: () => api.get<Page<Student>>("/students", { query: { q: q || undefined, limit: 50, status: activeOnly ? "active" : undefined } }),
    enabled: !disabled,
    staleTime: 30_000,
  });
  const items = results.data?.items ?? [];
  const hasSelected = !value || items.some((s) => s.id === value);
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-select`} className="text-xs font-bold">
        {label}
        {required ? (
          <span className="ml-1 text-danger" aria-hidden>
            *
          </span>
        ) : null}
        {required ? <span className="sr-only">（必須）</span> : null}
      </label>
      <Input
        type="search"
        aria-label={`${label}を社員名・社員番号で検索`}
        placeholder="社員名・社員番号で検索"
        value={text}
        disabled={disabled}
        maxLength={100}
        onChange={(e) => setText(e.target.value)}
      />
      <Select
        id={`${id}-select`}
        value={value}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={errorId}
        aria-required={required || undefined}
        onChange={(e) => {
          const s = items.find((x) => x.id === e.target.value);
          onChange(s ? { id: s.id, display_name: s.display_name, employee_number: s.employee_number, department_name: s.department_name, teacher_id: s.teacher_id } : null);
        }}
      >
        <option value="">{results.isLoading ? "読み込み中…" : items.length ? "選択してください" : "該当する新入社員がいません"}</option>
        {!hasSelected ? <option value={value}>{selectedLabel ?? "選択中の新入社員"}</option> : null}
        {items.map((s) => (
          <option key={s.id} value={s.id}>
            {s.display_name}（{s.employee_number}・{s.department_name}）
          </option>
        ))}
      </Select>
      {results.data?.next_cursor ? <p className="text-[11px] text-muted">候補が多いため先頭50件を表示しています。検索で絞り込んでください。</p> : null}
      {results.error ? <p className="text-xs text-danger">新入社員の一覧を取得できませんでした。</p> : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
