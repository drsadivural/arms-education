/**
 * POST /imports/{id}/commit orchestration (docs/08 「サーバーでstream/分割transaction」「ジョブをresume可能にし、
 * 失敗transactionの範囲を表示」).
 *
 * Transaction boundaries:
 *   claim   one tx: state/idempotency checks, lease (lease_token + locked_until), state → committing, audit
 *   batch   one tx per ≤200 rows (updates first, then creates) for classrooms / progress and for people updates:
 *           renew the lease, apply, record each row's commit_state + committed_version, audit — all or nothing
 *   people  account creation per row through the invitation saga (Auth provider calls outside transactions;
 *           the row's import item is marked inside the saga's profile transaction)
 *   finish  one tx: state → completed, lease released, audit
 * A retry (same job; same or new Idempotency-Key) continues with the rows that have no commit_state yet. A batch
 * that fails unexpectedly is rolled back as a whole and the job becomes `failed` with the batch's row range.
 * Requests stop after a time budget and leave the job in `committing` (lease released) for the next call.
 */
import type { ImportCommitInputT } from "@arms/contracts";
import type { AppContext } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, fail, mapDbError } from "../../http/errors";
import { requireIdempotencyKey } from "../../http/idempotency";
import { sha256Hex } from "../../auth/crypto";
import { audit, stableStringify } from "../admin/common";
import { applyClassrooms, applyPeopleUpdates, applyProgress, insertAudits, isRowConflict, writeCommitResults, type ApplyItem } from "./apply";
import { findJob } from "./jobs";
import type { JobRow, JobState } from "./model";
import { activateImportedAccount, createImportedAccount } from "./people";

export const BATCH_SIZE = 200;
export const LEASE_SECONDS = 120;
/** Wall-clock budget of one request; the job stays `committing` and the client calls again with the same key. */
export const REQUEST_BUDGET_MS = 20_000;

export class LeaseLost extends Error {}

export class BatchFailure extends Error {
  constructor(
    readonly error: ApiError,
    readonly fromRow: number | null,
    readonly toRow: number | null,
    readonly row: number | null,
  ) {
    super(error.code);
  }
}

/** Renews the lease inside a batch transaction; another request that took over the job makes this one stop. */
export async function renewLease(tx: Tx, orgId: string, jobId: string, token: string, states: readonly JobState[]): Promise<void> {
  const ok = await tx.maybeOne(sql`
    UPDATE app.import_jobs SET locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
    WHERE org_id = ${orgId} AND id = ${jobId} AND lease_token = ${token} AND state = ANY(${states}::text[])
    RETURNING id`);
  if (!ok) throw new LeaseLost();
}

const COMMITTING: readonly JobState[] = ["committing"];

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return mapDbError(e) ?? new ApiError("INTERNAL", { cause: e });
}

async function requestHash(c: AppContext, body: unknown): Promise<string> {
  return sha256Hex(stableStringify({ route: `${c.req.method} ${c.req.path}`, request: body }));
}

type Claim = { kind: "replay" } | { kind: "run"; job: JobRow; token: string };

async function claim(c: AppContext, jobId: string, input: ImportCommitInputT): Promise<Claim> {
  const actor = c.get("actor");
  const key = requireIdempotencyKey(c);
  const hash = await requestHash(c, { send_invitations: input.send_invitations === true, backup_confirmed: true });
  return actorTx(c, async (tx) => {
    const job = await findJob(tx, actor.orgId, jobId, { lock: true });
    if (!job) fail("NOT_FOUND");
    if (job.commit_key === key) {
      if (job.commit_hash !== hash) fail("IDEMPOTENCY_CONFLICT");
      if (job.state === "completed" || job.state === "rolled_back") return { kind: "replay" } as const;
    }
    if (job.state === "uploaded") fail("INVALID_STATE", { message_ja: "先にドライランを実行してください。" });
    if (job.state === "completed") fail("INVALID_STATE", { message_ja: "この移行は確定済みです。結果を再読み込みしてください。" });
    if (job.state === "rolled_back") fail("INVALID_STATE", { message_ja: "この移行は取り消し済みのため確定できません。新しい移行ジョブを作成してください。" });
    if (job.leased) fail("IMPORT_IN_PROGRESS");
    if (job.state === "validated") {
      const errors = await tx.one<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${jobId} AND action = 'error'`);
      if (errors.n > 0) fail("IMPORT_HAS_ERRORS", { details: { error_rows: errors.n } });
    }
    // A resumed commit keeps the options of the first request.
    const options = job.options ?? { send_invitations: input.send_invitations === true };
    const token = crypto.randomUUID();
    const updated = await tx.one<{ row_version: number }>(sql`
      UPDATE app.import_jobs SET state = 'committing', options = ${json(options)}::jsonb, commit_key = ${key}, commit_hash = ${hash},
        committed_by = coalesce(committed_by, ${actor.userId}::uuid), lease_token = ${token},
        locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), failure = NULL, updated_at = now(), row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${jobId} RETURNING row_version`);
    await audit(tx, actor, job.state === "validated" ? "import.commit_started" : "import.commit_resumed", jobId, {
      entity: job.entity,
      source_system: job.source_system,
      send_invitations: options.send_invitations,
      backup_confirmed: true,
      previous_state: job.state,
    });
    return { kind: "run", token, job: { ...job, options, state: "committing", row_version: updated.row_version } } as const;
  });
}

type BatchRow = ApplyItem;

async function nextRows(tx: Tx, orgId: string, jobId: string, filter: "updates" | "creates" | "all"): Promise<BatchRow[]> {
  const where =
    filter === "updates" ? sql`action = 'update'` : filter === "creates" ? sql`action = 'create'` : sql`action IN ('create', 'update')`;
  return tx.query<BatchRow>(sql`
    SELECT row_number, action, entity_id, before_data, after_data, commit_state FROM app.import_items
    WHERE org_id = ${orgId} AND job_id = ${jobId} AND ${where} AND (commit_state IS NULL OR commit_state = 'pending_activation')
    ORDER BY CASE WHEN action = 'update' THEN 0 ELSE 1 END, row_number
    LIMIT ${BATCH_SIZE} FOR UPDATE`);
}

/** One batch transaction for classrooms / progress (creates and updates) and people updates. Returns rows processed. */
async function runDataBatch(c: AppContext, job: JobRow, token: string): Promise<number> {
  const actor = c.get("actor");
  const people = job.entity === "teachers" || job.entity === "students";
  let range: { from: number; to: number } | null = null;
  try {
    return await actorTx(c, async (tx) => {
      await renewLease(tx, actor.orgId, job.id, token, COMMITTING);
      const rows = await nextRows(tx, actor.orgId, job.id, people ? "updates" : "all");
      if (rows.length === 0) return 0;
      range = { from: rows[0]?.row_number ?? 0, to: rows[rows.length - 1]?.row_number ?? 0 };
      const ctx = { tx, actor, jobId: job.id, sourceSystem: job.source_system };
      const outcome =
        job.entity === "progress"
          ? await applyProgress(ctx, rows)
          : job.entity === "classrooms"
            ? await applyClassrooms(ctx, rows)
            : await applyPeopleUpdates(ctx, job.entity, rows);
      await writeCommitResults(tx, actor.orgId, job.id, outcome.results);
      await insertAudits(tx, actor, outcome.audits);
      return rows.length;
    });
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    const r = range as { from: number; to: number } | null;
    throw new BatchFailure(toApiError(e), r?.from ?? null, r?.to ?? null, null);
  }
}

/** Account creation for imported people, row by row (each row is its own saga). Returns rows processed. */
async function runPeopleCreates(c: AppContext, job: JobRow, token: string, deadline: number): Promise<number> {
  const actor = c.get("actor");
  const entity = job.entity as "teachers" | "students";
  const rows = await actorTx(c, async (tx) => {
    await renewLease(tx, actor.orgId, job.id, token, COMMITTING);
    return nextRows(tx, actor.orgId, job.id, "creates");
  });
  let processed = 0;
  for (const item of rows) {
    if (processed > 0 && Date.now() > deadline) break;
    try {
      let userId = item.entity_id;
      if (item.commit_state !== "pending_activation") {
        try {
          userId = (await createImportedAccount(c, entity, job.id, { row: item.row_number, after: item.after_data }, job.options?.send_invitations === true)).userId;
        } catch (e) {
          const err = toApiError(e);
          if (!isRowConflict(err)) throw e;
          await actorTx(c, async (tx) => {
            await renewLease(tx, actor.orgId, job.id, token, COMMITTING);
            await writeCommitResults(tx, actor.orgId, job.id, [
              { row_number: item.row_number, state: "conflict", entity_id: null, version: null, message: err.message_ja },
            ]);
          });
          processed++;
          continue;
        }
      }
      await actorTx(c, async (tx) => {
        await renewLease(tx, actor.orgId, job.id, token, COMMITTING);
        const current = await tx.maybeOne<{ commit_state: string | null; entity_id: string | null }>(sql`
          SELECT commit_state, entity_id FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${job.id} AND row_number = ${item.row_number} FOR UPDATE`);
        if (current?.commit_state === "pending_activation" && current.entity_id) {
          await activateImportedAccount(tx, actor.orgId, job.id, item.row_number, current.entity_id);
        } else if (!current?.commit_state && userId) {
          // The saga finished in an earlier attempt that stopped before the item was marked (cannot normally happen:
          // the item is marked in the profile transaction). Record the account so rollback can find it.
          await tx.exec(sql`UPDATE app.import_items SET entity_id = ${userId}, committed_version = 1, commit_state = 'applied', committed_at = now()
            WHERE org_id = ${actor.orgId} AND job_id = ${job.id} AND row_number = ${item.row_number}`);
        }
      });
      processed++;
    } catch (e) {
      if (e instanceof LeaseLost) throw e;
      throw new BatchFailure(toApiError(e), item.row_number, item.row_number, item.row_number);
    }
  }
  return processed;
}

async function finish(c: AppContext, job: JobRow, token: string): Promise<boolean> {
  const actor = c.get("actor");
  return actorTx(c, async (tx) => {
    await renewLease(tx, actor.orgId, job.id, token, COMMITTING);
    const left = await tx.one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${job.id}
        AND action IN ('create', 'update') AND (commit_state IS NULL OR commit_state = 'pending_activation')`);
    if (left.n > 0) return false;
    const counts = await tx.one<{ applied: number; conflict: number }>(sql`
      SELECT count(*) FILTER (WHERE commit_state = 'applied')::int AS applied, count(*) FILTER (WHERE commit_state = 'conflict')::int AS conflict
      FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${job.id}`);
    await tx.exec(sql`
      UPDATE app.import_jobs SET state = 'completed', committed_at = now(), lease_token = NULL, locked_until = NULL, updated_at = now(),
        row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${job.id}`);
    await audit(tx, actor, "import.completed", job.id, { entity: job.entity, applied: counts.applied, conflict: counts.conflict });
    return true;
  });
}

async function releaseLease(c: AppContext, jobId: string, token: string): Promise<void> {
  const actor = c.get("actor");
  await actorTx(c, (tx) =>
    tx.exec(sql`UPDATE app.import_jobs SET lease_token = NULL, locked_until = NULL, updated_at = now()
      WHERE org_id = ${actor.orgId} AND id = ${jobId} AND lease_token = ${token}`),
  );
}

/** Records a failed batch (state failed, failure with the batch's row range) and releases the lease. */
export async function recordJobFailure(c: AppContext, job: JobRow, token: string, failure: BatchFailure, eventType: string): Promise<void> {
  const actor = c.get("actor");
  const err = failure.error;
  c.get("deps").log({
    level: err.status >= 500 ? "error" : "warn",
    msg: "import_batch_failed",
    request_id: c.get("requestId"),
    job_id: job.id,
    code: err.code,
    from_row: failure.fromRow,
    to_row: failure.toRow,
  });
  const body = { code: err.code, message_ja: err.message_ja, from_row: failure.fromRow, to_row: failure.toRow, row: failure.row };
  try {
    await actorTx(c, async (tx) => {
      const n = await tx.exec(sql`
        UPDATE app.import_jobs SET state = 'failed', failure = ${json(body)}::jsonb, lease_token = NULL, locked_until = NULL, updated_at = now(),
          row_version = row_version + 1
        WHERE org_id = ${actor.orgId} AND id = ${job.id} AND lease_token = ${token}`);
      if (n === 1) await audit(tx, actor, eventType, job.id, body);
    });
  } catch {
    // The database itself is unavailable: the caller reports the original error (the lease expires by itself).
    throw err;
  }
}

/**
 * Commits (or resumes) a validated import. Returns when the job is completed, failed (recorded) or the request's
 * time budget is used up (still committing).
 */
export async function commitImport(c: AppContext, jobId: string, input: ImportCommitInputT): Promise<void> {
  const claimed = await claim(c, jobId, input);
  if (claimed.kind === "replay") return;
  const { job, token } = claimed;
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const people = job.entity === "teachers" || job.entity === "students";
  try {
    for (;;) {
      if (Date.now() > deadline) {
        await releaseLease(c, job.id, token);
        return;
      }
      const n = await runDataBatch(c, job, token);
      if (n > 0) continue;
      if (people) {
        const created = await runPeopleCreates(c, job, token, deadline);
        if (created > 0) continue;
      }
      if (await finish(c, job, token)) return;
    }
  } catch (e) {
    if (e instanceof LeaseLost) fail("IMPORT_IN_PROGRESS");
    if (e instanceof BatchFailure) {
      await recordJobFailure(c, job, token, e, "import.commit_failed");
      return;
    }
    throw e;
  }
}
