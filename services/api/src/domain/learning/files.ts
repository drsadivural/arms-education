/**
 * Upload policy (docs/02 「ファイル」): content-type allowlist per purpose, size limits, filename rules and
 * server-side content verification (magic bytes / text encoding). The declared Content-Type, the filename
 * extension and the actual bytes must all agree; the filename is metadata only and never part of an object key.
 */

export type UploadPurpose = "material" | "assignment" | "import";
export type FileFamily = "pdf" | "video" | "image" | "csv";

const MB = 1024 * 1024;

interface TypeRule {
  family: FileFamily;
  extensions: readonly string[];
  maxBytes: number;
}

/** Allowed content types → family, extensions and the per-type size limit. */
export const CONTENT_TYPES: Record<string, TypeRule> = {
  "application/pdf": { family: "pdf", extensions: ["pdf"], maxBytes: 20 * MB },
  "video/mp4": { family: "video", extensions: ["mp4", "m4v"], maxBytes: 200 * MB },
  "video/quicktime": { family: "video", extensions: ["mov"], maxBytes: 200 * MB },
  "video/webm": { family: "video", extensions: ["webm"], maxBytes: 200 * MB },
  "image/png": { family: "image", extensions: ["png"], maxBytes: 10 * MB },
  "image/jpeg": { family: "image", extensions: ["jpg", "jpeg"], maxBytes: 10 * MB },
  "text/csv": { family: "csv", extensions: ["csv"], maxBytes: 10 * MB },
  // Windows browsers commonly report .csv files as application/vnd.ms-excel.
  "application/vnd.ms-excel": { family: "csv", extensions: ["csv"], maxBytes: 10 * MB },
};

export const PURPOSE_RULES: Record<UploadPurpose, { types: readonly string[]; maxBytes: number; roles: readonly string[] }> = {
  material: {
    types: ["application/pdf", "video/mp4", "video/quicktime", "video/webm", "image/png", "image/jpeg"],
    maxBytes: 200 * MB,
    roles: ["admin", "teacher"],
  },
  assignment: { types: ["application/pdf", "image/png", "image/jpeg"], maxBytes: 20 * MB, roles: ["student"] },
  import: { types: ["text/csv", "application/vnd.ms-excel"], maxBytes: 10 * MB, roles: ["admin"] },
};

/** Final storage prefix for clean files of each purpose. */
export const STORED_PREFIX: Record<UploadPurpose, string> = { material: "materials", assignment: "submissions", import: "imports" };

/** Material kinds that carry an uploaded file, and the file family each requires. */
export const FILE_MATERIAL_FAMILY: Record<string, FileFamily> = { pdf: "pdf", video: "video", image: "image" };

export function normalizeContentType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase();
}

export function fileExtension(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i + 1).toLowerCase() : "";
}

/** Validates an upload declaration. Returns field errors (Japanese) or null. */
export function checkUploadDeclaration(input: { filename: string; content_type: string; size_bytes: number; purpose: UploadPurpose }): {
  field_errors: Record<string, string>;
  tooLarge: boolean;
} | null {
  const errors: Record<string, string> = {};
  let tooLarge = false;
  const name = input.filename;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\]/.test(name) || name === "." || name === ".." || name.trim() !== name) {
    errors.filename = "ファイル名に使用できない文字が含まれています。";
  }
  const type = normalizeContentType(input.content_type);
  const rule = CONTENT_TYPES[type];
  const purpose = PURPOSE_RULES[input.purpose];
  if (!rule || !purpose.types.includes(type)) {
    errors.content_type = "このファイル形式はアップロードできません。";
  } else {
    if (!errors.filename && !rule.extensions.includes(fileExtension(name))) {
      errors.filename = `拡張子がファイル形式と一致しません（${rule.extensions.map((e) => `.${e}`).join("・")}）。`;
    }
    const limit = Math.min(rule.maxBytes, purpose.maxBytes);
    if (input.size_bytes > limit) {
      errors.size_bytes = `ファイルサイズは${Math.floor(limit / MB)}MB以下にしてください。`;
      tooLarge = true;
    }
  }
  return Object.keys(errors).length ? { field_errors: errors, tooLarge } : null;
}

/** Number of leading bytes read for magic-byte verification. */
export const SNIFF_BYTES = 4096;

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

const MP4_BRANDS_QT = new Set(["qt  "]);
const QT_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

/**
 * Verifies that the first bytes match the declared content type. CSV is verified separately on the whole file
 * (verifyTextFile). Returns the detected content type or null when the bytes do not match.
 */
export function sniffContentType(declared: string, head: Uint8Array): string | null {
  const type = normalizeContentType(declared);
  switch (type) {
    case "application/pdf":
      return ascii(head, 0, 5) === "%PDF-" ? type : null;
    case "image/png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? type : null;
    case "image/jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]) ? type : null;
    case "video/mp4": {
      if (ascii(head, 4, 4) !== "ftyp") return null;
      return MP4_BRANDS_QT.has(ascii(head, 8, 4)) ? null : type;
    }
    case "video/quicktime": {
      const atom = ascii(head, 4, 4);
      if (atom === "ftyp") return MP4_BRANDS_QT.has(ascii(head, 8, 4)) ? type : null;
      return QT_ATOMS.has(atom) ? type : null;
    }
    case "video/webm": {
      if (!startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return null;
      // EBML DocType element (0x42 0x82) followed by a size byte and "webm".
      for (let i = 4; i < Math.min(head.length - 6, 64); i++) {
        if (head[i] === 0x42 && head[i + 1] === 0x82 && ascii(head, i + 3, 4) === "webm") return type;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Strict UTF-8 validity check (rejects overlongs, surrogates and code points above U+10FFFF). */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Structural CP932 (Windows-31J) validity: single bytes 0x00–0x7F (ASCII) and 0xA1–0xDF (half-width katakana),
 * or a lead byte 0x81–0x9F / 0xE0–0xFC followed by a trail byte 0x40–0x7E / 0x80–0xFC.
 */
export function isValidCp932(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b <= 0x7f || (b >= 0xa1 && b <= 0xdf)) continue;
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      const t = bytes[i + 1];
      if (t === undefined || !((t >= 0x40 && t <= 0x7e) || (t >= 0x80 && t <= 0xfc))) return false;
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/** CSV/text verification: no NUL bytes and valid UTF-8 (with or without BOM) or CP932. */
export function verifyTextFile(bytes: Uint8Array): { encoding: "utf-8" | "cp932" } | null {
  if (bytes.includes(0)) return null;
  if (isValidUtf8(bytes)) return { encoding: "utf-8" };
  if (isValidCp932(bytes)) return { encoding: "cp932" };
  return null;
}

/** Sanitised download filename (kept for Content-Disposition only). */
export function displayFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 200);
}
