/**
 * Upload quarantine pipeline (docs/02 「ファイル」, API_NOTES 「ファイルupload completeはサーバーmagic byte確認と実scanner
 * 通知を完了条件にする」):
 *   POST /uploads → upload_jobs row + 15-minute presigned PUT to quarantine/<org>/<uuid> (never the filename)
 *   POST /uploads/{id}/complete → HEAD size == declared size, magic bytes / text encoding match the declared type,
 *     then the file is submitted to the malware scanner via a short-lived presigned GET.
 *   verdict clean → copied to <materials|submissions|imports>/<org>/<uuid>, quarantine copy removed;
 *   verdict blocked → quarantine copy deleted and recorded. No scanner configured → stays pending (never clean).
 */
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import type { ObjectStorage } from "../../integrations/storage";
import type { MalwareScanner, ScanVerdict } from "../../integrations/scanner";
import { ApiError } from "../../http/errors";
import { audit, iso, isoOrNull, num, outbox } from "./common";
import { CONTENT_TYPES, SNIFF_BYTES, STORED_PREFIX, normalizeContentType, sniffContentType, verifyTextFile, type UploadPurpose } from "./files";

export const UPLOAD_URL_SECONDS = 15 * 60;
/** Completion deadline (the presigned PUT itself expires after 15 minutes). */
export const UPLOAD_COMPLETE_SECONDS = 60 * 60;
/** Lifetime of the presigned GET handed to the scanner. */
export const SCANNER_FETCH_SECONDS = 15 * 60;

export type RunTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface UploadRow {
  id: string;
  org_id: string;
  user_id: string;
  purpose: UploadPurpose;
  object_key: string;
  quarantine_key: string | null;
  filename: string;
  content_type: string;
  expected_size: string;
  scan_state: "pending" | "clean" | "blocked" | "not_applicable";
  state: "awaiting_upload" | "scanning" | "clean" | "blocked" | "rejected" | "expired";
  expires_at: Date;
  detected_type: string | null;
  size_bytes: string | null;
  scan_reference: string | null;
  scan_submitted_at: Date | null;
  reject_code: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export const UPLOAD_COLUMNS = sql`id, org_id, user_id, purpose, object_key, quarantine_key, filename, content_type, expected_size, scan_state,
  state, expires_at, detected_type, size_bytes, scan_reference, scan_submitted_at, reject_code, created_at, completed_at`;

export function uploadStatusDto(r: UploadRow) {
  return {
    id: r.id,
    purpose: r.purpose,
    filename: r.filename,
    content_type: r.content_type,
    size_bytes: num(r.size_bytes ?? r.expected_size),
    state: r.state,
    scan_state: r.scan_state,
    object_key: r.quarantine_key ?? r.object_key,
    created_at: iso(r.created_at),
    completed_at: isoOrNull(r.completed_at),
    reject_code: r.reject_code,
  };
}

export function quarantineKeyOf(r: UploadRow): string {
  return r.quarantine_key ?? r.object_key;
}

export async function createUploadJob(
  tx: Tx,
  actor: Actor,
  storage: ObjectStorage,
  input: { filename: string; content_type: string; size_bytes: number; purpose: UploadPurpose },
  now: Date,
) {
  const id = crypto.randomUUID();
  const key = `quarantine/${actor.orgId}/${crypto.randomUUID()}`;
  const contentType = normalizeContentType(input.content_type);
  const expiresAt = new Date(now.getTime() + UPLOAD_COMPLETE_SECONDS * 1000);
  const presigned = await storage.presignPut(key, contentType, input.size_bytes, UPLOAD_URL_SECONDS);
  await tx.exec(sql`
    INSERT INTO app.upload_jobs(org_id, id, user_id, purpose, object_key, quarantine_key, filename, content_type, expected_size, scan_state, state, expires_at)
    VALUES (${actor.orgId}, ${id}, ${actor.userId}, ${input.purpose}, ${key}, ${key}, ${input.filename}, ${contentType}, ${input.size_bytes},
            'pending', 'awaiting_upload', ${expiresAt.toISOString()})`);
  await audit(tx, actor.orgId, actor.userId, "upload.created", id, {
    purpose: input.purpose,
    content_type: contentType,
    size_bytes: input.size_bytes,
  });
  return {
    id,
    upload_url: presigned.url,
    object_key: key,
    expires_at: new Date(now.getTime() + UPLOAD_URL_SECONDS * 1000).toISOString(),
    required_headers: presigned.headers,
  };
}

type VerifyOutcome =
  | { kind: "verified"; row: UploadRow }
  | { kind: "already"; row: UploadRow }
  | { kind: "rejected"; code: "size_mismatch" | "content_mismatch"; message: string }
  | { kind: "expired" };

const selectUpload = (orgId: string, uploadId: string, lock: boolean) =>
  sql`SELECT ${UPLOAD_COLUMNS} FROM app.upload_jobs WHERE org_id = ${orgId} AND id = ${uploadId} ${lock ? sql`FOR UPDATE` : sql``}`;

/**
 * Step 1 of completion: size + content verification. Object-storage reads happen outside any transaction; the
 * result is written in a short transaction that re-checks the upload is still awaiting completion.
 */
async function verifyUpload(runTx: RunTx, storage: ObjectStorage, actor: Actor, uploadId: string, now: Date): Promise<VerifyOutcome> {
  const row = await runTx((tx) => tx.maybeOne<UploadRow>(selectUpload(actor.orgId, uploadId, false)));
  if (!row || row.user_id !== actor.userId) throw new ApiError("NOT_FOUND");
  if (row.state === "expired") return { kind: "expired" };
  if (row.state === "rejected") throw new ApiError("FILE_REJECTED");
  if (row.state !== "awaiting_upload") return { kind: "already", row };
  if (new Date(row.expires_at) <= now) {
    await storage.delete(row.object_key);
    await runTx((tx) => tx.exec(sql`UPDATE app.upload_jobs SET state = 'expired' WHERE org_id = ${actor.orgId} AND id = ${uploadId} AND state = 'awaiting_upload'`));
    return { kind: "expired" };
  }

  const head = await storage.head(row.object_key);
  if (!head) throw new ApiError("UPLOAD_NOT_RECEIVED");
  let problem: { code: "size_mismatch" | "content_mismatch"; message: string } | null = null;
  let detected: string | null = null;
  if (head.size !== num(row.expected_size)) {
    problem = { code: "size_mismatch", message: "アップロードされたファイルのサイズが申告と一致しません。" };
  } else if (CONTENT_TYPES[row.content_type]?.family === "csv") {
    const bytes = await storage.readRange(row.object_key, 0, head.size);
    detected = bytes && bytes.length === head.size && verifyTextFile(bytes) ? row.content_type : null;
    if (!detected) problem = { code: "content_mismatch", message: "CSVファイルはUTF-8またはShift_JIS(CP932)のテキストである必要があります。" };
  } else {
    const bytes = await storage.readRange(row.object_key, 0, SNIFF_BYTES);
    detected = bytes ? sniffContentType(row.content_type, bytes) : null;
    if (!detected) problem = { code: "content_mismatch", message: "ファイルの内容が選択した形式と一致しません。" };
  }

  if (problem) {
    const rejected = problem;
    // The bytes are never verified or scanned: remove them before recording the rejection.
    await storage.delete(row.object_key);
    await runTx(async (tx) => {
      const locked = await tx.maybeOne<UploadRow>(selectUpload(actor.orgId, uploadId, true));
      if (!locked || locked.state !== "awaiting_upload") return;
      await tx.exec(sql`UPDATE app.upload_jobs SET state = 'rejected', reject_code = ${rejected.code}, size_bytes = ${head.size}, completed_at = ${now.toISOString()}
        WHERE org_id = ${actor.orgId} AND id = ${uploadId}`);
      await audit(tx, actor.orgId, actor.userId, "upload.rejected", uploadId, { code: rejected.code, declared_type: row.content_type, size_bytes: head.size });
    });
    return { kind: "rejected", ...rejected };
  }

  return runTx(async (tx): Promise<VerifyOutcome> => {
    const locked = await tx.maybeOne<UploadRow>(selectUpload(actor.orgId, uploadId, true));
    if (!locked) throw new ApiError("NOT_FOUND");
    if (locked.state !== "awaiting_upload") return { kind: "already", row: locked };
    const updated = await tx.one<UploadRow>(sql`
      UPDATE app.upload_jobs SET state = 'scanning', scan_state = 'pending', detected_type = ${detected}, size_bytes = ${head.size},
        completed_at = ${now.toISOString()}
      WHERE org_id = ${actor.orgId} AND id = ${uploadId} RETURNING ${UPLOAD_COLUMNS}`);
    await audit(tx, actor.orgId, actor.userId, "upload.verified", uploadId, { detected_type: detected, size_bytes: head.size });
    return { kind: "verified", row: updated };
  });
}

export function scanCallbackUrl(appOrigin: string, orgId: string, uploadId: string): string {
  return `${appOrigin}/api/v1/uploads/${uploadId}/scan-result?org=${orgId}`;
}

/** Submits a verified upload to the scanner. Returns null when the scanner could not be reached (retried by the job). */
export async function submitToScanner(
  storage: ObjectStorage,
  scanner: MalwareScanner,
  row: UploadRow,
  callbackUrl: string,
  log: (e: Record<string, unknown>) => void,
): Promise<{ verdict: ScanVerdict; scanId: string | null } | null> {
  try {
    const downloadUrl = await storage.presignGet(quarantineKeyOf(row), SCANNER_FETCH_SECONDS, { contentType: row.detected_type ?? row.content_type });
    return await scanner.submit({ uploadId: row.id, objectKey: quarantineKeyOf(row), downloadUrl, callbackUrl });
  } catch (e) {
    const err = e as { code?: string; name?: string };
    log({ level: "warn", msg: "scan_submit_failed", upload_id: row.id, error_code: err.code, error_name: err.name });
    return null;
  }
}

/** Records that a scan is in flight (pending verdict with a scanner reference). */
export async function recordScanSubmission(tx: Tx, orgId: string, uploadId: string, scanId: string | null): Promise<void> {
  await tx.exec(sql`UPDATE app.upload_jobs SET scan_reference = coalesce(${scanId}, scan_reference), scan_submitted_at = now(), scan_attempts = scan_attempts + 1
    WHERE org_id = ${orgId} AND id = ${uploadId} AND state = 'scanning'`);
}

type Log = (e: Record<string, unknown>) => void;
const noLog: Log = () => undefined;

/**
 * Applies a final scanner verdict (idempotent: only an upload still in `scanning` changes). Object-storage work is
 * done outside transactions: a clean file is first copied to its final key (deterministic per upload, so a retry
 * overwrites rather than orphaning a copy), then the DB rows are switched in a short transaction that re-checks
 * the state, and only after the commit is the quarantine copy removed. A blocked file is deleted first and then
 * recorded. Draft materials and submissions that reference the upload follow the verdict.
 */
export async function applyVerdict(
  runTx: RunTx,
  storage: ObjectStorage,
  orgId: string,
  uploadId: string,
  verdict: Exclude<ScanVerdict, "pending">,
  log: Log = noLog,
): Promise<UploadRow | null> {
  const row = await runTx((tx) => tx.maybeOne<UploadRow>(selectUpload(orgId, uploadId, false)));
  if (!row || row.state !== "scanning") return null;
  const quarantine = quarantineKeyOf(row);
  if (verdict === "clean") {
    const finalKey = `${STORED_PREFIX[row.purpose]}/${orgId}/${row.id}`;
    const size = num(row.size_bytes ?? row.expected_size);
    // A previous attempt may already have copied the file (and even removed the quarantine copy) before failing.
    let copied = await storage.head(finalKey);
    if (!copied || copied.size !== size) {
      await storage.copy(quarantine, finalKey);
      copied = await storage.head(finalKey);
    }
    if (!copied || copied.size !== size) throw new ApiError("STORAGE_UNAVAILABLE");
    const updated = await runTx(async (tx) => {
      const locked = await tx.maybeOne<UploadRow>(selectUpload(orgId, uploadId, true));
      if (!locked || locked.state !== "scanning") return null;
      const done = await tx.one<UploadRow>(sql`
        UPDATE app.upload_jobs SET state = 'clean', scan_state = 'clean', object_key = ${finalKey}, scanned_at = now()
        WHERE org_id = ${orgId} AND id = ${uploadId} RETURNING ${UPLOAD_COLUMNS}`);
      await tx.exec(sql`
        UPDATE app.materials m SET scan_state = 'clean', object_key = ${finalKey}, size_bytes = ${size}, row_version = m.row_version + 1
        FROM app.units u JOIN app.program_versions v ON v.org_id = u.org_id AND v.id = u.program_version_id
        WHERE m.org_id = ${orgId} AND m.upload_id = ${uploadId} AND u.org_id = m.org_id AND u.id = m.unit_id AND v.state = 'draft'`);
      await tx.exec(sql`UPDATE app.submissions SET scan_state = 'clean', object_key = ${finalKey}, row_version = row_version + 1
        WHERE org_id = ${orgId} AND upload_id = ${uploadId}`);
      await audit(tx, orgId, null, "upload.scan_clean", uploadId, { purpose: row.purpose });
      await outbox(tx, orgId, "upload.scan_completed", uploadId, { upload_id: uploadId, user_id: row.user_id, verdict: "clean", purpose: row.purpose });
      return done;
    });
    if (updated) {
      try {
        await storage.delete(quarantine);
      } catch (e) {
        // The clean copy is already in place; a leftover quarantine object is never served or referenced.
        log({ level: "warn", msg: "quarantine_delete_failed", upload_id: uploadId, error_code: (e as { code?: string }).code });
      }
    }
    return updated;
  }
  await storage.delete(quarantine);
  return runTx(async (tx) => {
    const locked = await tx.maybeOne<UploadRow>(selectUpload(orgId, uploadId, true));
    if (!locked || locked.state !== "scanning") return null;
    const updated = await tx.one<UploadRow>(sql`
      UPDATE app.upload_jobs SET state = 'blocked', scan_state = 'blocked', scanned_at = now()
      WHERE org_id = ${orgId} AND id = ${uploadId} RETURNING ${UPLOAD_COLUMNS}`);
    await tx.exec(sql`
      UPDATE app.materials m SET scan_state = 'blocked', object_key = NULL, row_version = m.row_version + 1
      FROM app.units u JOIN app.program_versions v ON v.org_id = u.org_id AND v.id = u.program_version_id
      WHERE m.org_id = ${orgId} AND m.upload_id = ${uploadId} AND u.org_id = m.org_id AND u.id = m.unit_id AND v.state = 'draft'`);
    await tx.exec(sql`UPDATE app.submissions SET scan_state = 'blocked', object_key = NULL, row_version = row_version + 1
      WHERE org_id = ${orgId} AND upload_id = ${uploadId}`);
    await audit(tx, orgId, null, "upload.scan_blocked", uploadId, { purpose: row.purpose });
    await outbox(tx, orgId, "upload.scan_completed", uploadId, { upload_id: uploadId, user_id: row.user_id, verdict: "blocked", purpose: row.purpose });
    return updated;
  });
}

export interface CompleteDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner | null;
  appOrigin: string;
  now: Date;
  log: Log;
}

/** POST /uploads/{id}/complete orchestration. Storage and scanner calls happen outside DB transactions. */
export async function completeUpload(runTx: RunTx, deps: CompleteDeps, actor: Actor, uploadId: string): Promise<UploadRow> {
  const outcome = await verifyUpload(runTx, deps.storage, actor, uploadId, deps.now);
  if (outcome.kind === "expired") throw new ApiError("UPLOAD_EXPIRED");
  if (outcome.kind === "rejected") {
    throw new ApiError("FILE_REJECTED", { message_ja: outcome.message, details: { reject_code: outcome.code } });
  }
  let row = outcome.row;
  if (row.state !== "scanning" || !deps.scanner || row.scan_reference) return row;
  const submitted = await submitToScanner(deps.storage, deps.scanner, row, scanCallbackUrl(deps.appOrigin, actor.orgId, row.id), deps.log);
  if (!submitted) return row;
  await runTx((tx) => recordScanSubmission(tx, actor.orgId, uploadId, submitted.scanId));
  if (submitted.verdict !== "pending") await applyVerdict(runTx, deps.storage, actor.orgId, uploadId, submitted.verdict, deps.log);
  row = await runTx((tx) => tx.one<UploadRow>(selectUpload(actor.orgId, uploadId, false)));
  // The blocked verdict is committed (file deleted, audit recorded) before the client is told.
  if (row.state === "blocked") {
    throw new ApiError("FILE_REJECTED", {
      message_ja: "ファイル検査で問題が検出されたため、このファイルは利用できません。",
      details: { upload_id: uploadId, scan_state: "blocked" },
    });
  }
  return row;
}

/**
 * Applies a verified (HMAC-checked) scanner callback. The scan id must match the one recorded at submission; a
 * callback that races ahead of that record is accepted for the upload in `scanning` and records the id.
 * Repeated callbacks after the final verdict are idempotent.
 */
export async function handleScanCallback(
  runTx: RunTx,
  storage: ObjectStorage,
  orgId: string,
  uploadId: string,
  scanId: string,
  verdict: ScanVerdict,
  log: Log = noLog,
): Promise<UploadRow> {
  const row = await runTx(async (tx) => {
    const locked = await tx.maybeOne<UploadRow>(selectUpload(orgId, uploadId, true));
    if (!locked) throw new ApiError("NOT_FOUND");
    if (locked.scan_reference && locked.scan_reference !== scanId) throw new ApiError("INVALID_STATE");
    if (locked.state === "clean" || locked.state === "blocked") return locked;
    if (locked.state !== "scanning") throw new ApiError("INVALID_STATE");
    if (!locked.scan_reference) {
      await tx.exec(sql`UPDATE app.upload_jobs SET scan_reference = ${scanId}, scan_submitted_at = coalesce(scan_submitted_at, now())
        WHERE org_id = ${orgId} AND id = ${uploadId}`);
    }
    return { ...locked, scan_reference: scanId };
  });
  if (row.state !== "scanning" || verdict === "pending") return row;
  await applyVerdict(runTx, storage, orgId, uploadId, verdict, log);
  return runTx((tx) => tx.one<UploadRow>(selectUpload(orgId, uploadId, false)));
}

/** Resolves a client-supplied object key (Upload.object_key) to an upload of this organisation. */
export async function findUploadByKey(tx: Tx, orgId: string, key: string): Promise<UploadRow | null> {
  return tx.maybeOne<UploadRow>(sql`SELECT ${UPLOAD_COLUMNS} FROM app.upload_jobs
    WHERE org_id = ${orgId} AND (quarantine_key = ${key} OR object_key = ${key}) FOR UPDATE`);
}

/** An upload that may be attached to a material/submission: verified (scanning) or clean, never rejected/blocked. */
export function assertAttachable(row: UploadRow | null, purpose: UploadPurpose, fieldName: string): asserts row is UploadRow {
  if (!row || row.purpose !== purpose) {
    throw new ApiError("VALIDATION_FAILED", { field_errors: { [fieldName]: "アップロードしたファイルを選択してください。" } });
  }
  if (row.state === "blocked" || row.state === "rejected") throw new ApiError("FILE_REJECTED");
  if (row.state === "expired") throw new ApiError("UPLOAD_EXPIRED");
  if (row.state === "awaiting_upload") throw new ApiError("UPLOAD_NOT_READY");
}
