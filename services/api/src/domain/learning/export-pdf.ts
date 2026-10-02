/**
 * PDF rendering of 社員教育進捗 records: A4 landscape table with an embedded subset of Noto Sans JP (pdf-lib +
 * fontkit embed only the glyphs used). Imported lazily by exports.ts.
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { OVERDUE_LABEL, PROGRESS_RECORD_COLUMN_LABELS, PROGRESS_RECORD_STATE_LABELS, formatDateJa } from "@arms/contracts";
import type { ExportRecord } from "./export-render";

/** Ideographic space (written as a code point to keep the source free of irregular whitespace). */
const SP = String.fromCharCode(0x3000);
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 36;
const FONT_SIZE = 8.5;
const LINE_H = 12;
const CELL_PAD = 4;

interface Column {
  label: string;
  width: number;
  maxLines: number;
  value: (r: ExportRecord) => string;
}

const COLUMNS: Column[] = [
  { label: PROGRESS_RECORD_COLUMN_LABELS.due_date, width: 96, maxLines: 1, value: (r) => formatDateJa(r.due_date, { withYear: true }) },
  { label: PROGRESS_RECORD_COLUMN_LABELS.student_name, width: 92, maxLines: 2, value: (r) => r.student_name },
  { label: PROGRESS_RECORD_COLUMN_LABELS.department_name, width: 88, maxLines: 2, value: (r) => r.department_name },
  { label: PROGRESS_RECORD_COLUMN_LABELS.teacher_name, width: 88, maxLines: 2, value: (r) => r.teacher_name },
  { label: PROGRESS_RECORD_COLUMN_LABELS.content, width: 254, maxLines: 3, value: (r) => r.content },
  {
    label: "状態",
    width: 102,
    maxLines: 2,
    value: (r) => (r.overdue ? `${OVERDUE_LABEL}（${PROGRESS_RECORD_STATE_LABELS[r.state]}）` : PROGRESS_RECORD_STATE_LABELS[r.state]),
  },
  { label: "進捗", width: 49.89, maxLines: 1, value: (r) => (r.progress_percent === null ? "未設定" : `${r.progress_percent}%`) },
];

export interface PdfMeta {
  title: string;
  organization: string;
  filterSummary: string;
  generatedAt: string;
}

/** Replaces characters the embedded font cannot render with 〓 (geta mark) and flattens whitespace. */
function renderable(text: string, charset: Set<number>): string {
  let out = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    out += charset.has(cp) ? ch : charset.has(0x3013) ? "〓" : "?";
  }
  return out;
}

/** Greedy character wrap (Japanese has no word spaces); the last line is ellipsised when truncated. */
function wrap(text: string, font: PDFFont, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (font.widthOfTextAtSize(line + ch, FONT_SIZE) > width) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line += ch;
    }
  }
  if (lines.length < maxLines) {
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }
  // Truncated: ellipsise the last kept line.
  let last = lines[maxLines - 1] ?? "";
  while (last && font.widthOfTextAtSize(`${last}…`, FONT_SIZE) > width) last = last.slice(0, -1);
  lines[maxLines - 1] = `${last}…`;
  return lines.slice(0, maxLines);
}

export async function buildPdf(rows: ExportRecord[], meta: PdfMeta, fontBytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const charset = new Set(font.getCharacterSet());
  doc.setTitle(renderable(meta.title, charset));
  doc.setProducer("ARMS");
  doc.setCreator("ARMS 新入社員研修システム");

  const text = (page: PDFPage, s: string, x: number, y: number, size = FONT_SIZE, color = rgb(0.1, 0.12, 0.16)) =>
    page.drawText(renderable(s, charset), { x, y, size, font, color });
  const tableWidth = COLUMNS.reduce((s, c) => s + c.width, 0);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = 0;
  const drawHeader = (first: boolean) => {
    y = PAGE_H - MARGIN;
    if (first) {
      text(page, meta.title, MARGIN, y - 14, 15);
      y -= 24;
      text(page, `${meta.organization}${SP}${meta.filterSummary}`, MARGIN, y - 9, 9, rgb(0.3, 0.33, 0.38));
      text(page, `出力日時: ${meta.generatedAt}${SP}件数: ${rows.length}件`, MARGIN, y - 22, 9, rgb(0.3, 0.33, 0.38));
      y -= 34;
    }
    const h = LINE_H + CELL_PAD * 2;
    page.drawRectangle({ x: MARGIN, y: y - h, width: tableWidth, height: h, color: rgb(0.92, 0.94, 0.97) });
    let x = MARGIN;
    for (const col of COLUMNS) {
      text(page, col.label, x + CELL_PAD, y - CELL_PAD - FONT_SIZE);
      x += col.width;
    }
    y -= h;
  };
  drawHeader(true);

  if (rows.length === 0) {
    text(page, "該当する教育記録はありません。", MARGIN + CELL_PAD, y - CELL_PAD - FONT_SIZE - 4, 10);
  }
  for (const r of rows) {
    const cells = COLUMNS.map((col) => wrap(renderable(col.value(r), charset), font, col.width - CELL_PAD * 2, col.maxLines));
    const lines = Math.max(...cells.map((c) => c.length));
    const h = lines * LINE_H + CELL_PAD * 2;
    if (y - h < MARGIN + 20) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      drawHeader(false);
    }
    let x = MARGIN;
    cells.forEach((cellLines, i) => {
      cellLines.forEach((line, li) => text(page, line, x + CELL_PAD, y - CELL_PAD - FONT_SIZE - li * LINE_H));
      x += COLUMNS[i]!.width;
    });
    y -= h;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + tableWidth, y }, thickness: 0.4, color: rgb(0.8, 0.82, 0.86) });
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    p.drawText(label, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 8), y: MARGIN - 16, size: 8, font, color: rgb(0.4, 0.42, 0.46) });
  });
  return doc.save();
}
