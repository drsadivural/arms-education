/** Quarantined uploads: presigned PUT, completion (byte verification + scanner), status and scanner callback. */
import { Hono } from "hono";
import { ScanCallbackInput, UploadInput } from "@arms/contracts";
import type { AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { ApiError, fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { action, ok } from "../../http/respond";
import { isUuid, pathId, readBody, zodFieldErrors } from "../../http/validation";
import { mapScanStatus } from "../../integrations/scanner";
import { PURPOSE_RULES, checkUploadDeclaration } from "../../domain/learning/files";
import { UPLOAD_COLUMNS, completeUpload, createUploadJob, handleScanCallback, uploadStatusDto, type UploadRow } from "../../domain/learning/uploads";

export const uploadRoutes = new Hono<AppEnv>();

/** POST /uploads — validates type/size/filename and returns a 15-minute presigned PUT into quarantine. */
uploadRoutes.post("/uploads", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const input = await readBody(c, UploadInput);
  if (!PURPOSE_RULES[input.purpose].roles.includes(actor.role)) fail("FORBIDDEN");
  const problem = checkUploadDeclaration(input);
  if (problem) {
    const onlySize = problem.tooLarge && Object.keys(problem.field_errors).length === 1;
    throw new ApiError(onlySize ? "FILE_TOO_LARGE" : "VALIDATION_FAILED", { field_errors: problem.field_errors });
  }
  const storage = c.get("deps").integrations.storage;
  if (!storage) fail("NOT_CONFIGURED");
  const now = c.get("deps").now();
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => ({ status: 200, body: await createUploadJob(tx, actor, storage, input, now) })),
  );
  return ok(c, result.body);
});

/** POST /uploads/{id}/complete — HEAD size check, magic bytes / encoding, then scanner submission. */
uploadRoutes.post("/uploads/:id/complete", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const deps = c.get("deps");
  const storage = deps.integrations.storage;
  if (!storage) fail("NOT_CONFIGURED");
  const row = await completeUpload(
    (fn) => actorTx(c, fn),
    { storage, scanner: deps.integrations.scanner, appOrigin: deps.config.appOrigin, now: deps.now(), log: deps.log },
    actor,
    id,
  );
  return action(c, { ...uploadStatusDto(row), scanner_configured: deps.integrations.scanner !== null });
});

/** GET /uploads/{id} — quarantine/scan status for the uploader (or an admin). */
uploadRoutes.get("/uploads/:id", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const row = await actorTx(c, (tx: Tx) => tx.maybeOne<UploadRow>(sql`SELECT ${UPLOAD_COLUMNS} FROM app.upload_jobs WHERE org_id = ${actor.orgId} AND id = ${id}`));
  if (!row || (row.user_id !== actor.userId && actor.role !== "admin")) fail("NOT_FOUND");
  return ok(c, uploadStatusDto(row));
});

const MAX_CALLBACK_BYTES = 64 * 1024;

/**
 * POST /uploads/{id}/scan-result — asynchronous scanner verdict. Authenticated by the HMAC signature, not by a user
 * session: it must be listed in PUBLIC_ENDPOINTS (routes/index.ts) to be reachable by the scanner. Until then the
 * learning cron polls the scanner for pending verdicts.
 */
uploadRoutes.post("/uploads/:id/scan-result", async (c) => {
  const id = pathId(c);
  const org = c.req.query("org");
  if (!isUuid(org)) fail("NOT_FOUND");
  const deps = c.get("deps");
  const scanner = deps.integrations.scanner;
  const storage = deps.integrations.storage;
  if (!scanner || !storage) fail("NOT_CONFIGURED");
  const raw = await c.req.text();
  if (raw.length > MAX_CALLBACK_BYTES) fail("BAD_REQUEST");
  const valid = await scanner.verifyCallback({
    timestamp: c.req.header("X-ARMS-Scan-Timestamp"),
    signature: c.req.header("X-ARMS-Scan-Signature"),
    rawBody: raw,
    now: deps.now(),
  });
  if (!valid) fail("SCAN_SIGNATURE_INVALID");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    fail("BAD_REQUEST", { message_ja: "JSONの形式が正しくありません。" });
  }
  const parsed = ScanCallbackInput.safeParse(parsedJson);
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED", { field_errors: zodFieldErrors(parsed.error) });
  if (parsed.data.upload_id && parsed.data.upload_id.toLowerCase() !== id) {
    throw new ApiError("VALIDATION_FAILED", { field_errors: { upload_id: "URLのアップロードIDと一致しません。" } });
  }
  const row = await handleScanCallback(
    (fn) => c.get("db").tx({ orgId: org.toLowerCase() }, fn),
    storage,
    org.toLowerCase(),
    id,
    parsed.data.scan_id,
    mapScanStatus(parsed.data.status),
    deps.log,
  );
  deps.log({ level: "info", msg: "scan_callback", upload_id: id, state: row.state });
  return action(c, { upload_id: id, state: row.state, scan_state: row.scan_state });
});
