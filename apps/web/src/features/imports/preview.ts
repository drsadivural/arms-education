/**
 * Local preview of the selected CSV before upload: encoding detection (BOM / UTF-8 / Shift_JIS), header row and the
 * first data rows. The server re-checks everything on the dry run; this only helps the admin choose the encoding
 * and the column mapping.
 */
import { IMPORT_LIMITS, type ImportEncoding } from "@arms/contracts";

export type DetectedEncoding = ImportEncoding | "ascii" | "unknown";

export interface CsvPreview {
  detected: DetectedEncoding;
  headers: string[];
  rows: string[][];
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (hasBom(bytes)) return "utf-8-bom";
  if (bytes.every((b) => b < 0x80)) return "ascii";
  if (tryDecode(bytes, "utf-8") !== null) return "utf-8";
  if (tryDecode(bytes, "shift_jis") !== null) return "cp932";
  return "unknown";
}

export function decodeAs(bytes: Uint8Array, encoding: ImportEncoding): string | null {
  if (encoding === "cp932") return tryDecode(bytes, "shift_jis");
  const text = tryDecode(hasBom(bytes) ? bytes.subarray(3) : bytes, "utf-8");
  return text;
}

/** Minimal RFC 4180 reader for the first `limit` records (quotes, "" escapes, CRLF, line breaks inside quotes). */
export function readRecords(text: string, limit: number): string[][] {
  const out: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && out.length < limit; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      out.push(cells);
      cells = [];
      cell = "";
    } else cell += ch;
  }
  if (out.length < limit && (cell !== "" || cells.length > 0)) out.push([...cells, cell]);
  return out;
}

function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer().then((b) => new Uint8Array(b));
  // Older engines without Blob.arrayBuffer.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export async function previewFile(file: File, encoding?: ImportEncoding): Promise<CsvPreview & { encoding: ImportEncoding; decodeFailed: boolean }> {
  // Only the head of the file is needed for the preview.
  const bytes = await readBytes(file.slice(0, Math.min(file.size, 256 * 1024)));
  const detected = detectEncoding(bytes);
  const chosen: ImportEncoding = encoding ?? (detected === "ascii" || detected === "unknown" ? "utf-8" : detected);
  // A cut in the middle of a multi-byte character at the 256 KB boundary must not fail the preview.
  const text = decodeAs(bytes, chosen) ?? decodeAs(bytes.subarray(0, Math.max(0, bytes.length - 3)), chosen);
  if (text === null) return { detected, headers: [], rows: [], encoding: chosen, decodeFailed: true };
  const records = readRecords(text, 6);
  const [header = [], ...rows] = records;
  return { detected, headers: header.map((h) => h.trim()), rows, encoding: chosen, decodeFailed: false };
}

export function fileProblem(file: File): string | null {
  if (!/\.csv$/i.test(file.name)) return "CSVファイル（.csv）を選択してください。Excelの場合は「CSV（コンマ区切り）」で保存してください。";
  if (file.size === 0) return "ファイルが空です。";
  if (file.size > IMPORT_LIMITS.maxBytes) return "ファイルサイズが上限（10MB）を超えています。ファイルを分割してください。";
  return null;
}
