/**
 * RFC 4180 CSV reading and writing for the legacy data migration (docs/08).
 *
 * Reading: comma-separated, records end with CRLF / LF / CR, fields may be quoted with `"` (`""` escapes a quote)
 * and quoted fields may contain commas and line breaks. Cell values are returned as text and are never evaluated
 * (a cell such as `=SUM(A1)` is just a string).
 *
 * Writing (error reports): every cell is quoted, and cells that a spreadsheet would treat as a formula
 * (starting with = + - @ TAB CR) are prefixed with a single quote (CSV formula injection).
 */

export interface CsvRecord {
  /** 1-based physical line where the record starts (for syntax error messages). */
  line: number;
  cells: string[];
}

export class CsvSyntaxError extends Error {
  constructor(
    readonly line: number,
    readonly reason: "unterminated_quote" | "text_after_quote",
  ) {
    super(reason);
  }
}

const QUOTE = 34;
const COMMA = 44;
const CR = 13;
const LF = 10;

function countLineBreaks(value: string): number {
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === LF) n++;
    else if (c === CR) {
      n++;
      if (value.charCodeAt(i + 1) === LF) i++;
    }
  }
  return n;
}

/**
 * Parses CSV text (without BOM). Stops after `maxRecords` records and reports `truncated` when more data follows.
 * A trailing line break does not create an extra record.
 */
export function parseCsv(text: string, maxRecords: number): { records: CsvRecord[]; truncated: boolean } {
  const records: CsvRecord[] = [];
  const n = text.length;
  if (n === 0) return { records, truncated: false };
  let cells: string[] = [];
  let line = 1;
  let recordLine = 1;
  let i = 0;
  for (;;) {
    let value: string;
    let next: number;
    if (text.charCodeAt(i) === QUOTE) {
      let j = i + 1;
      value = "";
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) throw new CsvSyntaxError(recordLine, "unterminated_quote");
        value += text.slice(j, q);
        if (text.charCodeAt(q + 1) === QUOTE) {
          value += '"';
          j = q + 2;
          continue;
        }
        next = q + 1;
        break;
      }
      line += countLineBreaks(value);
      if (next < n) {
        const c = text.charCodeAt(next);
        if (c !== COMMA && c !== CR && c !== LF) throw new CsvSyntaxError(line, "text_after_quote");
      }
    } else {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === COMMA || c === CR || c === LF) break;
        j++;
      }
      value = text.slice(i, j);
      next = j;
    }
    cells.push(value);
    if (next >= n) {
      records.push({ line: recordLine, cells });
      return { records, truncated: false };
    }
    const sep = text.charCodeAt(next);
    if (sep === COMMA) {
      i = next + 1;
      if (i >= n) {
        cells.push("");
        records.push({ line: recordLine, cells });
        return { records, truncated: false };
      }
      continue;
    }
    // Line break: end of record.
    records.push({ line: recordLine, cells });
    cells = [];
    i = next + 1;
    if (sep === CR && text.charCodeAt(i) === LF) i++;
    line++;
    recordLine = line;
    if (i >= n) return { records, truncated: false };
    if (records.length >= maxRecords) return { records, truncated: true };
  }
}

/** True when every cell is empty or whitespace (e.g. trailing ",,,," rows exported by spreadsheets). */
export function isBlankRecord(cells: readonly string[]): boolean {
  return cells.every((c) => c.trim() === "");
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Neutralises spreadsheet formulas: cells starting with = + - @ TAB CR get a leading single quote. */
export function escapeFormula(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

/** One CSV record with every cell quoted and formula-escaped (CRLF line ending). */
export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return (
    cells
      .map((cell) => {
        const text = escapeFormula(cell === null || cell === undefined ? "" : String(cell));
        return `"${text.replace(/"/g, '""')}"`;
      })
      .join(",") + "\r\n"
  );
}
