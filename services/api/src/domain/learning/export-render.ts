/**
 * CSV and PDF rendering of 社員教育進捗 records.
 * CSV: UTF-8 with BOM (Excel-compatible), CRLF, every cell quoted, legacy Japanese headers first, and CSV formula
 * injection neutralised (cells starting with = + - @ TAB CR are prefixed with an apostrophe, docs/08).
 * PDF rendering lives in export-pdf.ts (loaded lazily so pdf-lib/fontkit are only initialised when a PDF is built);
 * its font is loaded at runtime from object storage (PDF_FONT_KEY) to keep the Worker small.
 */
import { OVERDUE_LABEL, PROGRESS_RECORD_COLUMN_LABELS, PROGRESS_RECORD_STATE_LABELS } from "@arms/contracts";
import type { ObjectStorage } from "../../integrations/storage";
import { ApiError } from "../../http/errors";

export interface ExportRecord {
  due_date: string;
  student_name: string;
  department_name: string;
  teacher_name: string;
  content: string;
  state: keyof typeof PROGRESS_RECORD_STATE_LABELS;
  overdue: boolean;
  progress_percent: number | null;
  employee_number: string;
  classroom_name: string | null;
  notes: string;
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Quotes a CSV cell and neutralises spreadsheet formula injection. */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const CSV_HEADERS = [
  PROGRESS_RECORD_COLUMN_LABELS.due_date,
  PROGRESS_RECORD_COLUMN_LABELS.student_name,
  PROGRESS_RECORD_COLUMN_LABELS.department_name,
  PROGRESS_RECORD_COLUMN_LABELS.teacher_name,
  PROGRESS_RECORD_COLUMN_LABELS.content,
  "状態",
  OVERDUE_LABEL,
  "進捗率(%)",
  "社員番号",
  "クラス",
  "備考",
];

export function buildCsv(rows: ExportRecord[]): Uint8Array {
  const lines = [CSV_HEADERS.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.due_date,
        r.student_name,
        r.department_name,
        r.teacher_name,
        r.content,
        PROGRESS_RECORD_STATE_LABELS[r.state],
        r.overdue ? OVERDUE_LABEL : "",
        r.progress_percent === null ? "未設定" : r.progress_percent,
        r.employee_number,
        r.classroom_name ?? "",
        r.notes,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const text = `${lines.join("\r\n")}\r\n`;
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

// ---- PDF ----------------------------------------------------------------------------------------

/** Object-storage key of the Japanese font (upload services/api/assets/fonts/NotoSansJP-Regular-CP932.ttf here). */
export const PDF_FONT_KEY = "system/fonts/NotoSansJP-Regular-CP932.ttf";

let fontCache: Uint8Array | null = null;

/** Loads (and caches per isolate) the PDF font from storage; missing font → PDF_FONT_UNAVAILABLE. */
export async function loadPdfFont(storage: ObjectStorage): Promise<Uint8Array> {
  if (fontCache) return fontCache;
  const stream = await storage.get(PDF_FONT_KEY);
  if (!stream) throw new ApiError("PDF_FONT_UNAVAILABLE");
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (bytes.length < 1024) throw new ApiError("PDF_FONT_UNAVAILABLE");
  fontCache = bytes;
  return bytes;
}

/** Test hook: forget the cached font. */
export function resetPdfFontCache(): void {
  fontCache = null;
}
