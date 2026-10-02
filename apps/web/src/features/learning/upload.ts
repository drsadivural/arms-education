/**
 * Material file uploads (docs/02 「ファイル」): POST /uploads (purpose material) → PUT the bytes to the presigned
 * quarantine URL with the required headers → POST /uploads/{id}/complete → poll GET /uploads/{id} until the scanner
 * verdict (clean / blocked). The client-side checks below only mirror the server limits to fail fast; the server
 * (declared type + extension + magic bytes + size) remains authoritative.
 */
import type { ActionResult, DataResponse } from "@arms/contracts";
import { api } from "../../lib/api";
import type { MaterialKind, UploadStatus, UploadTicket } from "./api";

const MB = 1024 * 1024;

export type FileMaterialKind = Extract<MaterialKind, "pdf" | "video" | "image">;

interface FileRule {
  label: string;
  maxBytes: number;
  /** content type → allowed extensions */
  types: Record<string, readonly string[]>;
}

/** Same allowlist and per-type limits as services/api/src/domain/learning/files.ts (PDF 20MB, 動画 200MB, 画像 10MB). */
export const MATERIAL_FILE_RULES: Record<FileMaterialKind, FileRule> = {
  pdf: { label: "PDF", maxBytes: 20 * MB, types: { "application/pdf": ["pdf"] } },
  video: { label: "動画", maxBytes: 200 * MB, types: { "video/mp4": ["mp4", "m4v"], "video/quicktime": ["mov"], "video/webm": ["webm"] } },
  image: { label: "画像", maxBytes: 10 * MB, types: { "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"] } },
};

export const FILE_KINDS: readonly FileMaterialKind[] = ["pdf", "video", "image"];

export function isFileKind(kind: string): kind is FileMaterialKind {
  return (FILE_KINDS as readonly string[]).includes(kind);
}

/** `accept` attribute for the file input of a kind (or all material file types). */
export function acceptFor(kind?: FileMaterialKind): string {
  const rules = kind ? [MATERIAL_FILE_RULES[kind]] : Object.values(MATERIAL_FILE_RULES);
  return rules.flatMap((r) => [...Object.keys(r.types), ...Object.values(r.types).flat().map((e) => `.${e}`)]).join(",");
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Material kind implied by a file (for the 「教材を追加」 drop zone), or null when the type is not allowed. */
export function kindForFile(file: Pick<File, "name" | "type">): FileMaterialKind | null {
  const ext = extensionOf(file.name);
  for (const kind of FILE_KINDS) {
    const rule = MATERIAL_FILE_RULES[kind];
    if (file.type && rule.types[file.type.toLowerCase()]) return kind;
    if (Object.values(rule.types).some((exts) => exts.includes(ext))) return kind;
  }
  return null;
}

export type FileCheck = { ok: true; contentType: string } | { ok: false; message: string };

/**
 * Validates type (declared type or, when the browser reports none, the extension), extension/type agreement and
 * size before anything is sent. Returns the content type to declare to POST /uploads.
 */
export function checkMaterialFile(kind: FileMaterialKind, file: Pick<File, "name" | "type" | "size">): FileCheck {
  const rule = MATERIAL_FILE_RULES[kind];
  const ext = extensionOf(file.name);
  const allowedExt = Object.values(rule.types).flat();
  const declared = file.type.toLowerCase();
  let contentType: string | undefined;
  if (declared && rule.types[declared]) contentType = declared;
  else if (!declared) contentType = Object.entries(rule.types).find(([, exts]) => exts.includes(ext))?.[0];
  if (!contentType) {
    return { ok: false, message: `${rule.label}教材には ${allowedExt.map((e) => `.${e}`).join("・")} のファイルを選択してください。` };
  }
  if (!rule.types[contentType]!.includes(ext)) {
    return { ok: false, message: `拡張子がファイル形式と一致しません（${rule.types[contentType]!.map((e) => `.${e}`).join("・")}）。` };
  }
  if (file.size <= 0) return { ok: false, message: "空のファイルはアップロードできません。" };
  if (file.size > rule.maxBytes) return { ok: false, message: `${rule.label}のファイルサイズは${rule.maxBytes / MB}MB以下にしてください。` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\]/.test(file.name) || file.name.trim() !== file.name || file.name.length > 200) {
    return { ok: false, message: "ファイル名に使用できない文字が含まれているか、長すぎます（200文字以内）。" };
  }
  return { ok: true, contentType };
}

/** The presigned PUT failed (network/CORS or storage rejection). Nothing was registered as a material. */
export class UploadTransferError extends Error {
  readonly messageJa: string;
  constructor(messageJa: string) {
    super(messageJa);
    this.messageJa = messageJa;
  }
}

/**
 * PUTs the file to the presigned URL with exactly the required headers (Content-Type is signed) and reports byte
 * progress through XMLHttpRequest upload events (fetch has no upload progress).
 */
export function putFile(
  ticket: Pick<UploadTicket, "upload_url" | "required_headers">,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", ticket.upload_url);
    for (const [name, value] of Object.entries(ticket.required_headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new UploadTransferError(`ファイルの送信に失敗しました（保管サービスの応答 ${xhr.status}）。もう一度ファイルを選択してください。`));
      }
    };
    xhr.onerror = () => reject(new UploadTransferError("ファイルを送信できませんでした。ネットワーク接続を確認して、もう一度お試しください。"));
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export const requestUpload = (input: { filename: string; content_type: string; size_bytes: number }, idempotencyKey: string) =>
  api.post<DataResponse<UploadTicket>>("/uploads", { ...input, purpose: "material" }, { idempotencyKey });

export interface CompletedUpload extends UploadStatus {
  scanner_configured: boolean;
}

export async function completeUpload(uploadId: string): Promise<CompletedUpload> {
  const res = await api.post<ActionResult>(`/uploads/${uploadId}/complete`);
  return res.data as unknown as CompletedUpload;
}

export const getUploadStatus = (uploadId: string) => api.get<DataResponse<UploadStatus>>(`/uploads/${uploadId}`);

/** Upload states that are final for polling purposes. */
export function isUploadSettled(state: UploadStatus["state"]): boolean {
  return state !== "scanning" && state !== "awaiting_upload";
}
