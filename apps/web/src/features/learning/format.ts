/** Pure display helpers of the learning screens (unit-tested in test/learning-format.test.ts). */
import {
  MATERIAL_KIND_LABELS,
  PROGRESS_RECORD_COLUMN_LABELS,
  PROGRESS_RECORD_STATE_LABELS,
  addMonths,
  formatDateJa,
  formatMonthJa,
  parseDateOnly,
  zonedDateString,
} from "@arms/contracts";
import { ORG_TZ } from "../../lib/format";
import type { Material, Unit } from "./api";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** YYYY-MM of "now" in the organisation timezone (JST) — never derived from the browser's UTC date. */
export function currentMonth(now: Date = new Date()): string {
  return zonedDateString(now, ORG_TZ).slice(0, 7);
}

export function isMonth(value: string | null | undefined): value is string {
  return !!value && MONTH_RE.test(value);
}

/** The month in the URL when valid, otherwise the current JST month. */
export function resolveMonth(value: string | null | undefined, now: Date = new Date()): string {
  return isMonth(value) ? value : currentMonth(now);
}

export const shiftMonth = (month: string, delta: number) => addMonths(month, delta);

/** "2026年10月" */
export const monthLabel = (month: string) => formatMonthJa(month);

/** "10月" — the heading 「10月の教育記録」. */
export function monthShortLabel(month: string): string {
  const m = MONTH_RE.exec(month);
  return m ? `${Number(m[2])}月` : month;
}

/**
 * Due dates are date-only values shown exactly as stored (legacy 2019 rows keep 2019). The year is added when it
 * differs from the year being viewed so old and future records are never ambiguous.
 */
export function dueDateLabel(date: string, viewYear?: number): string {
  const parsed = parseDateOnly(date);
  if (!parsed) return date;
  return formatDateJa(date, { withYear: viewYear === undefined || parsed.year !== viewYear });
}

/** 「2019年8月31日（土）」 */
export const fullDateLabel = (date: string) => formatDateJa(date, { withYear: true });

export const progressColumnLabels = PROGRESS_RECORD_COLUMN_LABELS;
export const recordStateLabels = PROGRESS_RECORD_STATE_LABELS;

export function versionLabel(versionNumber: number): string {
  return `v${versionNumber}`;
}

const MB = 1024 * 1024;
/** "12.5 MB" / "820 KB" */
export function fileSizeLabel(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const VIEWABLE: Material["kind"][] = ["pdf", "video", "image", "link"];

/** 「PDF / 動画 / テスト」 summary of a unit's material kinds (design WEB-10 教材 column). */
export function materialKindsSummary(materials: Pick<Material, "kind">[]): string {
  const kinds = [...new Set(materials.map((m) => m.kind))];
  if (kinds.length === 0) return "教材なし";
  return kinds.map((k) => (k === "quiz" ? "テスト" : MATERIAL_KIND_LABELS[k])).join(" / ");
}

/**
 * 完了条件 text in the same terms the server evaluates (docs/04): required viewable materials confirmed, required
 * quiz ≥ pass score (null → 100点 = 全問正解), required assignment submitted or accepted by the teacher, attendance.
 */
export function completionConditionLabel(
  unit: Pick<Unit, "pass_score" | "required_attendance" | "requires_review">,
  materials: Pick<Material, "kind" | "required">[],
): string {
  const required = materials.filter((m) => m.required);
  const parts: string[] = [];
  if (required.some((m) => VIEWABLE.includes(m.kind))) parts.push("確認");
  if (required.some((m) => m.kind === "quiz")) parts.push(unit.pass_score === null ? "テスト全問正解" : `${unit.pass_score}点以上`);
  if (required.some((m) => m.kind === "assignment")) parts.push(unit.requires_review ? "課題の講師承認" : "課題提出");
  else if (unit.requires_review) parts.push("講師承認");
  if (unit.required_attendance) parts.push("出席");
  return parts.length ? parts.join(" + ") : "条件未設定";
}

/** Two-digit order label 「01」 (positions are stored from 0 or 1; shown as stored + 1 when 0-based). */
export function orderLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}
