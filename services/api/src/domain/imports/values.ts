/**
 * Strict parsing of legacy cell values. Dates keep the original year (2019 stays 2019); non-existent dates,
 * ambiguous formats and unknown state words are errors, never guesses.
 */
import { z } from "zod";
import { parseDateOnly, type ProgressRecordState } from "@arms/contracts";

export type DateParse = { ok: true; value: string } | { ok: false; reason: "format" | "nonexistent" | "weekday" };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const ISO_LIKE = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:\s+0?0:00(?::00)?)?$/;
const JAPANESE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:\(\s*([日月火水木金土])(?:曜日?)?\s*\))?$/;

/**
 * Accepts YYYY-MM-DD, YYYY/M/D (optionally with a midnight time as exported by spreadsheets) and 2019年8月31日
 * (optionally with the weekday 「（土）」, which must match). Full-width digits are normalised (NFKC).
 */
export function parseImportDate(raw: string): DateParse {
  const value = raw.normalize("NFKC").trim();
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  let weekday: string | undefined;
  const iso = ISO_LIKE.exec(value);
  const ja = iso ? null : JAPANESE.exec(value);
  if (iso) [, year, , month, day] = iso;
  else if (ja) [, year, month, day, weekday] = ja;
  else return { ok: false, reason: "format" };
  const y = Number(year);
  if (y < 1900 || y > 2100) return { ok: false, reason: "format" };
  const iso10 = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = parseDateOnly(iso10);
  if (!parsed) return { ok: false, reason: "nonexistent" };
  if (weekday !== undefined) {
    const actual = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
    if (WEEKDAYS[actual] !== weekday) return { ok: false, reason: "weekday" };
  }
  return { ok: true, value: iso10 };
}

const norm = (raw: string) => raw.normalize("NFKC").trim().toLowerCase();

const ACTIVE_TRUE = new Set(["有効", "在籍", "在籍中", "利用中", "active", "true", "yes", "1", "○", "はい"]);
const ACTIVE_FALSE = new Set(["無効", "停止", "停止中", "在籍終了", "退職", "inactive", "false", "no", "0", "×", "いいえ"]);

/** 有効/無効 (and common synonyms). null = not recognisable. */
export function parseActive(raw: string): boolean | null {
  const v = norm(raw);
  if (ACTIVE_TRUE.has(v)) return true;
  if (ACTIVE_FALSE.has(v)) return false;
  return null;
}

const STATE_WORDS: Record<string, ProgressRecordState> = {
  未確認: "unverified",
  unverified: "unverified",
  未着手: "not_started",
  未実施: "not_started",
  not_started: "not_started",
  受講中: "in_progress",
  実施中: "in_progress",
  進行中: "in_progress",
  in_progress: "in_progress",
  確認待ち: "review_pending",
  レビュー待ち: "review_pending",
  review_pending: "review_pending",
  完了: "completed",
  修了: "completed",
  済: "completed",
  済み: "completed",
  completed: "completed",
};

/** Legacy 学習完了状態. Empty → 未確認 (never inferred as completed); unknown words → null (row error). */
export function parseProgressState(raw: string): ProgressRecordState | null {
  const v = norm(raw);
  if (v === "") return "unverified";
  return STATE_WORDS[v] ?? null;
}

/** Positive integer such as 「30」「３０」「30名」. */
export function parseCount(raw: string, min: number, max: number): number | null {
  const v = raw.normalize("NFKC").trim().replace(/[名人]$/, "");
  if (!/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

const EMAIL = z.email().max(254);
export function isEmail(value: string): boolean {
  return EMAIL.safeParse(value).success;
}

/** Text cell: trimmed, CRLF/CR inside the value normalised to LF (content is otherwise kept as written). */
export function cleanText(raw: string | undefined): string {
  return (raw ?? "").replace(/\r\n?/g, "\n").trim();
}
