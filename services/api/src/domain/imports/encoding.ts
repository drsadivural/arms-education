/**
 * Character-encoding detection and decoding of uploaded CSV files (UTF-8, UTF-8 with BOM, CP932/Windows-31J).
 *
 * Workers' TextDecoder only guarantees UTF-8, so CP932 is decoded with the pure-JS `encoding-japanese` library.
 * Its SJIS table covers the CP932 extensions (NEC special characters, NEC-selected and IBM extensions); bytes that
 * are not valid CP932 structure, user-defined characters (外字, 0xF040–0xF9FC) and unassigned codes (which the
 * library would turn into "?") are rejected instead of silently corrupting data.
 */
import * as EncodingModule from "encoding-japanese";
import type { ImportEncoding } from "@arms/contracts";
import { ApiError } from "../../http/errors";

// CommonJS module: the namespace is the default export under Node ESM interop, the module itself when bundled.
const Encoding = ((EncodingModule as unknown as { default?: typeof EncodingModule }).default ?? EncodingModule) as typeof EncodingModule;

export type DetectedEncoding = ImportEncoding | "ascii";

export const ENCODING_NAMES: Record<DetectedEncoding, string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8（BOM付き）",
  cp932: "Shift_JIS（CP932）",
  ascii: "英数字のみ",
};

export interface DecodedFile {
  text: string;
  detected: DetectedEncoding;
  /** Declared and detected differ only by the BOM (UTF-8 vs UTF-8 with BOM); the file is still read. */
  mismatch: boolean;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function lineAt(bytes: Uint8Array, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < bytes.length; i++) if (bytes[i] === 0x0a) line++;
  return line;
}

/** Structural CP932 check. Returns null when valid, otherwise the byte offset of the first problem and its kind. */
function cp932Problem(bytes: Uint8Array): { index: number; kind: "invalid" | "gaiji" } | null {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b <= 0x7f || (b >= 0xa1 && b <= 0xdf)) continue;
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      const t = bytes[i + 1];
      if (t === undefined || t < 0x40 || t === 0x7f || t > 0xfc) return { index: i, kind: "invalid" };
      if (b >= 0xf0 && b <= 0xf9) return { index: i, kind: "gaiji" };
      i++;
      continue;
    }
    return { index: i, kind: "invalid" };
  }
  return null;
}

/** Decodes CP932 and verifies that every double-byte code was mapped (the library substitutes "?" otherwise). */
function decodeCp932(bytes: Uint8Array): { text: string } | { badIndex: number } {
  const text = Encoding.convert(bytes, { to: "UNICODE", from: "SJIS", type: "string" });
  let out = 0;
  for (let i = 0; i < bytes.length; i++, out++) {
    const b = bytes[i] as number;
    const double = (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
    if (double) {
      if (text.charCodeAt(out) === 0x3f) return { badIndex: i };
      i++;
    }
  }
  if (out !== text.length) return { badIndex: 0 };
  return { text };
}

/**
 * Detects the actual encoding and decodes with the declared one. Throws Japanese API errors when the file is not
 * text (NUL bytes), cannot be decoded, or the declared encoding contradicts the content (UTF-8 vs CP932).
 */
export function decodeImportFile(bytes: Uint8Array, declared: ImportEncoding): DecodedFile {
  const nul = bytes.indexOf(0);
  if (nul !== -1) {
    throw new ApiError("IMPORT_ENCODING_UNSUPPORTED", {
      message_ja: `テキスト形式のCSVではありません（${lineAt(bytes, nul)}行目付近に制御文字があります）。`,
      details: { line: lineAt(bytes, nul) },
    });
  }
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasBom ? bytes.subarray(3) : bytes;
  const ascii = !hasBom && body.every((b) => b < 0x80);
  const utf8 = decodeUtf8(body);
  let detected: DetectedEncoding;
  if (ascii) detected = "ascii";
  else if (utf8 !== null) detected = hasBom ? "utf-8-bom" : "utf-8";
  else if (!hasBom && cp932Problem(body) === null) detected = "cp932";
  else {
    const problem = hasBom ? null : cp932Problem(body);
    if (problem?.kind === "gaiji") {
      throw new ApiError("IMPORT_ENCODING_UNSUPPORTED", {
        message_ja: `Shift_JIS（CP932）の外字（利用者定義文字）が${lineAt(body, problem.index)}行目付近にあるため変換できません。標準の文字に置き換えてください。`,
        details: { line: lineAt(body, problem.index) },
      });
    }
    throw new ApiError("IMPORT_ENCODING_UNSUPPORTED");
  }

  const utfFamily = detected === "utf-8" || detected === "utf-8-bom";
  if ((declared === "cp932" && utfFamily) || (declared !== "cp932" && detected === "cp932")) {
    throw new ApiError("IMPORT_ENCODING_MISMATCH", {
      message_ja: `指定した文字コード（${ENCODING_NAMES[declared]}）とファイルの文字コード（${ENCODING_NAMES[detected]}）が一致しません。文字コードを選び直してください。`,
      details: { declared, detected },
    });
  }

  if (detected === "cp932") {
    const decoded = decodeCp932(body);
    if ("badIndex" in decoded) {
      throw new ApiError("IMPORT_ENCODING_UNSUPPORTED", {
        message_ja: `Shift_JIS（CP932）で変換できない文字が${lineAt(body, decoded.badIndex)}行目付近にあります。`,
        details: { line: lineAt(body, decoded.badIndex) },
      });
    }
    return { text: decoded.text, detected, mismatch: false };
  }
  const text = utf8 ?? "";
  const mismatch = detected !== "ascii" && detected !== declared;
  return { text, detected, mismatch };
}
