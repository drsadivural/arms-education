/**
 * Column mapping checks ({source CSV header → target field}) and the import source file (upload) checks.
 */
import { IMPORT_FIELDS, type ImportEntity } from "@arms/contracts";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, fail } from "../../http/errors";

/**
 * Field errors are keyed `mapping.<field>` (the mapping screen lists target fields). Unknown target fields,
 * a target used by two columns and unmapped required fields are rejected; with `headers` (the file's header row)
 * every mapped header must exist exactly once.
 */
export function checkMapping(entity: ImportEntity, columns: Record<string, string>, headers?: readonly string[]): void {
  const defs = IMPORT_FIELDS[entity];
  const errors: Record<string, string> = {};
  const used = new Map<string, string[]>();
  for (const [header, field] of Object.entries(columns)) {
    if (!defs.some((d) => d.field === field)) {
      errors[`mapping.${field}`] ??= `取り込み先の項目「${field}」はありません。`;
      continue;
    }
    used.set(field, [...(used.get(field) ?? []), header]);
  }
  for (const def of defs) {
    const sources = used.get(def.field) ?? [];
    if (sources.length > 1) errors[`mapping.${def.field}`] = `${def.label}に複数の列（${sources.map((h) => `「${h}」`).join("・")}）が対応付けられています。1つにしてください。`;
    else if (sources.length === 0 && def.required) errors[`mapping.${def.field}`] = `${def.label}は必須です。対応する列を選択してください。`;
    else if (sources.length === 1 && headers) {
      const header = sources[0] as string;
      const count = headers.filter((h) => h === header).length;
      if (count === 0) errors[`mapping.${def.field}`] = `ファイルに見出し「${header}」の列がありません。項目の対応を修正してください。`;
      else if (count > 1) errors[`mapping.${def.field}`] = `見出し「${header}」の列がファイル内に複数あります。見出しを一意にしてください。`;
    }
  }
  if (Object.keys(errors).length > 0) throw new ApiError("IMPORT_MAPPING_INVALID", { field_errors: errors });
}

export interface ImportUpload {
  id: string;
  user_id: string;
  purpose: string;
  object_key: string;
  filename: string;
  state: "awaiting_upload" | "scanning" | "clean" | "blocked" | "rejected" | "expired";
  scan_state: string;
  reject_code: string | null;
  expired: boolean;
}

/**
 * The upload must be the caller's own purpose=import upload whose scan verdict is clean (learning upload
 * lifecycle: awaiting_upload → scanning → clean | blocked; rejected / expired). Only clean files are read, from
 * their final private key (upload_jobs.object_key); the URL is never returned.
 */
export async function loadImportUpload(tx: Tx, orgId: string, userId: string, uploadId: string, scannerConfigured: boolean): Promise<ImportUpload> {
  const upload = await tx.maybeOne<ImportUpload>(sql`
    SELECT id, user_id, purpose, object_key, filename, state, scan_state, reject_code, expires_at <= now() AS expired
    FROM app.upload_jobs WHERE org_id = ${orgId} AND id = ${uploadId}`);
  if (!upload || upload.user_id !== userId) fail("VALIDATION_FAILED", { field_errors: { upload_id: "アップロードしたファイルが見つかりません。もう一度アップロードしてください。" } });
  if (upload.purpose !== "import") fail("VALIDATION_FAILED", { field_errors: { upload_id: "データ移植用にアップロードしたCSVファイルを選択してください。" } });
  switch (upload.state) {
    case "clean":
      if (upload.scan_state !== "clean") fail("IMPORT_UPLOAD_NOT_READY");
      return upload;
    case "awaiting_upload":
      if (upload.expired) fail("UPLOAD_EXPIRED");
      return fail("IMPORT_UPLOAD_NOT_READY", { message_ja: "ファイルのアップロードが完了していません。アップロードを完了してから選択してください。" });
    case "scanning":
      if (!scannerConfigured) {
        return fail("IMPORT_UPLOAD_NOT_READY", {
          message_ja:
            "ファイル検査（マルウェアスキャン）サービスが設定されていないため、アップロードしたファイルを取り込めません。検査済みのファイルだけを取り込みます。システム管理者にファイル検査サービスの設定を依頼してください。",
          details: { scanner_configured: false },
        });
      }
      return fail("IMPORT_UPLOAD_NOT_READY", { details: { scanner_configured: true } });
    case "blocked":
      return fail("IMPORT_UPLOAD_REJECTED", { message_ja: "ファイル検査で問題が検出されたため、このファイルは取り込めません。別のファイルをアップロードしてください。" });
    case "rejected":
      return fail("IMPORT_UPLOAD_REJECTED", {
        message_ja:
          upload.reject_code === "size_mismatch"
            ? "アップロードされたファイルのサイズが申告と一致しなかったため受け付けていません。もう一度アップロードしてください。"
            : "ファイルの内容がCSV（UTF-8またはShift_JIS）ではないため受け付けていません。CSV形式で保存したファイルをアップロードしてください。",
        details: { reject_code: upload.reject_code },
      });
    case "expired":
      return fail("UPLOAD_EXPIRED");
  }
}
