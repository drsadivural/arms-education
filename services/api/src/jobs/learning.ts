/**
 * Learning cron work (every minute). Each organisation runs with its own tenant context; a failure in one step or
 * organisation is logged and does not stop the others.
 *  1. expire upload_jobs whose completion deadline passed (quarantine object deleted)
 *  2. scanner polling fallback: submit verified uploads that were never submitted, and poll pending verdicts
 *     (works without the public callback endpoint)
 *  3. generate pending progress exports (large exports are not generated in the request)
 *  4. delete export files past their retention
 */
import type { Deps } from "../context";
import { RequestDb } from "../db/client";
import { sql } from "../db/sql";
import { ApiError } from "../http/errors";
import {
  UPLOAD_COLUMNS,
  applyVerdict,
  quarantineKeyOf,
  recordScanSubmission,
  scanCallbackUrl,
  submitToScanner,
  type UploadRow,
} from "../domain/learning/uploads";
import { claimPendingExport, exportActor, loadExportRecords, markExportFailed, markExportReady, renderExport } from "../domain/learning/exports";
import type { RecordFilters } from "../domain/learning/progress-records";

const UPLOAD_BATCH = 50;
const SCAN_BATCH = 20;
const EXPORTS_PER_RUN = 3;
const EXPORT_RETRIES = 3;
const TRANSIENT = new Set(["STORAGE_UNAVAILABLE", "DB_UNAVAILABLE", "SERVICE_UNAVAILABLE"]);

type Log = Deps["log"];

function logError(log: Log, step: string, orgId: string, e: unknown): void {
  const err = e as { name?: string; code?: string; message?: string };
  log({ level: "error", msg: "learning_job_failed", step, org_id: orgId, error_name: err?.name, error_code: err?.code, error_message: err?.message?.slice(0, 300) });
}

export async function runLearningJobs(deps: Deps): Promise<void> {
  const db = new RequestDb(deps.connections);
  try {
    const orgs = await db.tx({}, (tx) => tx.query<{ id: string }>(sql`SELECT id FROM app.organizations ORDER BY id`));
    for (const org of orgs) {
      for (const [step, fn] of [
        ["expire_uploads", expireUploads],
        ["poll_scans", pollScans],
        ["generate_exports", generateExports],
        ["expire_exports", expireExportFiles],
      ] as const) {
        try {
          await fn(deps, db, org.id);
        } catch (e) {
          logError(deps.log, step, org.id, e);
        }
      }
    }
  } finally {
    await db.close();
  }
}

export async function expireUploads(deps: Deps, db: RequestDb, orgId: string): Promise<number> {
  const storage = deps.integrations.storage;
  const now = deps.now().toISOString();
  return db.tx({ orgId }, async (tx) => {
    const rows = await tx.query<UploadRow>(sql`SELECT ${UPLOAD_COLUMNS} FROM app.upload_jobs
      WHERE org_id = ${orgId} AND state = 'awaiting_upload' AND expires_at <= ${now}
      ORDER BY expires_at LIMIT ${UPLOAD_BATCH} FOR UPDATE SKIP LOCKED`);
    for (const r of rows) {
      // Whatever was uploaded after the deadline is never verified or scanned: remove it.
      if (storage) await storage.delete(quarantineKeyOf(r));
      await tx.exec(sql`UPDATE app.upload_jobs SET state = 'expired' WHERE org_id = ${orgId} AND id = ${r.id}`);
    }
    return rows.length;
  });
}

export async function pollScans(deps: Deps, db: RequestDb, orgId: string): Promise<number> {
  const { storage, scanner } = deps.integrations;
  if (!storage || !scanner) return 0;
  const rows = await db.tx({ orgId }, (tx) =>
    tx.query<UploadRow>(sql`SELECT ${UPLOAD_COLUMNS} FROM app.upload_jobs
      WHERE org_id = ${orgId} AND state = 'scanning' ORDER BY scan_submitted_at NULLS FIRST, completed_at LIMIT ${SCAN_BATCH}`),
  );
  let resolved = 0;
  for (const row of rows) {
    try {
      let verdict: "clean" | "blocked" | "pending";
      if (!row.scan_reference) {
        const submitted = await submitToScanner(storage, scanner, row, scanCallbackUrl(deps.config.appOrigin, orgId, row.id), deps.log);
        if (!submitted) continue;
        await db.tx({ orgId }, (tx) => recordScanSubmission(tx, orgId, row.id, submitted.scanId));
        verdict = submitted.verdict;
      } else {
        verdict = await scanner.status(row.scan_reference);
      }
      if (verdict === "pending") continue;
      const applied = await applyVerdict((fn) => db.tx({ orgId }, fn), storage, orgId, row.id, verdict, deps.log);
      if (applied) resolved++;
    } catch (e) {
      logError(deps.log, "poll_scan", orgId, e);
    }
  }
  return resolved;
}

/**
 * Generates leased pending exports: rows are read in a short transaction (with the creator's current scope), the
 * file is rendered and stored outside any transaction, and the job is marked ready in a second short transaction.
 * Transient storage failures leave the job pending (retried when the lease expires, up to EXPORT_RETRIES attempts).
 */
export async function generateExports(deps: Deps, db: RequestDb, orgId: string): Promise<number> {
  const storage = deps.integrations.storage;
  if (!storage) return 0;
  let done = 0;
  for (let i = 0; i < EXPORTS_PER_RUN; i++) {
    const now = deps.now();
    const claimed = await db.tx({ orgId }, async (tx) => {
      const job = await claimPendingExport(tx, orgId);
      if (!job) return "empty" as const;
      const actor = await exportActor(tx, orgId, job.user_id);
      if (!actor) {
        await markExportFailed(tx, orgId, job.id, "FORBIDDEN");
        return "failed" as const;
      }
      try {
        return { job, actor, records: await loadExportRecords(tx, actor, job.filters as RecordFilters, now) };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        await markExportFailed(tx, orgId, job.id, e.code);
        return "failed" as const;
      }
    });
    if (claimed === "empty") break;
    if (claimed === "failed") continue;
    const { job, actor, records } = claimed;
    try {
      const file = await renderExport(storage, job, actor, records, now);
      await db.tx({ orgId, userId: actor.userId }, (tx) => markExportReady(tx, actor, job, file));
      done++;
    } catch (e) {
      logError(deps.log, "generate_export", orgId, e);
      const code = e instanceof ApiError ? e.code : "INTERNAL";
      // job.attempts already counts this attempt (claimPendingExport increments it).
      if (!(TRANSIENT.has(code) && job.attempts < EXPORT_RETRIES)) {
        await db.tx({ orgId }, (tx) => markExportFailed(tx, orgId, job.id, code));
      }
    }
  }
  return done;
}

export async function expireExportFiles(deps: Deps, db: RequestDb, orgId: string): Promise<number> {
  const storage = deps.integrations.storage;
  if (!storage) return 0;
  const now = deps.now().toISOString();
  return db.tx({ orgId }, async (tx) => {
    const rows = await tx.query<{ id: string; object_key: string }>(sql`SELECT id, object_key FROM app.export_jobs
      WHERE org_id = ${orgId} AND state = 'ready' AND object_key IS NOT NULL AND file_expires_at <= ${now}
        AND filters->>'kind' = 'progress_records'
      LIMIT ${UPLOAD_BATCH} FOR UPDATE SKIP LOCKED`);
    for (const r of rows) {
      await storage.delete(r.object_key);
      await tx.exec(sql`UPDATE app.export_jobs SET object_key = NULL WHERE org_id = ${orgId} AND id = ${r.id}`);
    }
    return rows.length;
  });
}
