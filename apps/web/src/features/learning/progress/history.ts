/** Japanese rendering of 教育記録 correction history entries (before → after, reason, actor, time). */
import { PROGRESS_RECORD_STATE_LABELS } from "@arms/contracts";
import type { ProgressRecordHistoryEntry } from "../api";
import { fullDateLabel } from "../format";

const FIELD_LABELS: Record<string, string> = {
  due_date: "終了予定日",
  student_id: "社員名",
  department_name: "教育担当部署",
  teacher_name: "教育担当者",
  teacher_id: "教育担当者",
  content: "内容",
  notes: "備考",
  state: "状態",
};

const FIELD_ORDER = ["due_date", "student_id", "department_name", "teacher_name", "teacher_id", "content", "state", "notes"];

export const RECORD_EVENT_LABELS: Record<string, string> = {
  "progress_record.created": "教育記録を登録",
  "progress_record.corrected": "教育記録を訂正",
  "progress_record.imported": "既存システムから移行",
};

function display(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "（なし）";
  if (field === "due_date" && typeof value === "string") return fullDateLabel(value);
  if (field === "state" && typeof value === "string") return PROGRESS_RECORD_STATE_LABELS[value as keyof typeof PROGRESS_RECORD_STATE_LABELS] ?? value;
  return String(value);
}

export interface ChangeLine {
  field: string;
  label: string;
  before: string;
  after: string;
}

/**
 * Before/after lines of an entry. IDs are not meaningful to readers: a teacher change is shown by the recorded name
 * snapshot, a student change as 「別の社員に変更」.
 */
export function changeLines(entry: Pick<ProgressRecordHistoryEntry, "changes">): ChangeLine[] {
  const changes = entry.changes ?? {};
  const rank = (f: string) => (FIELD_ORDER.includes(f) ? FIELD_ORDER.indexOf(f) : 99);
  const fields = Object.keys(changes).sort((a, b) => rank(a) - rank(b));
  const lines: ChangeLine[] = [];
  for (const f of fields) {
    if (f === "teacher_id" && "teacher_name" in changes) continue;
    if (!(f in FIELD_LABELS)) continue;
    const c = changes[f]!;
    if (f === "student_id" || f === "teacher_id") {
      const who = f === "student_id" ? "社員" : "講師";
      lines.push({ field: f, label: FIELD_LABELS[f]!, before: c.before ? `変更前の${who}` : "（なし）", after: c.before ? `別の${who}に変更` : "登録" });
      continue;
    }
    lines.push({ field: f, label: FIELD_LABELS[f]!, before: display(f, c.before), after: display(f, c.after) });
  }
  return lines;
}

export function eventLabel(eventType: string): string {
  return RECORD_EVENT_LABELS[eventType] ?? eventType;
}
