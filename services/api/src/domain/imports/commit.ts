/**
 * POST /imports/{id}/commit orchestration (docs/08 「サーバーでstream/分割transaction」「ジョブをresume可能にし、
 * 失敗transactionの範囲を表示」).
 *
 * Transaction boundaries:
 *   claim   one tx: state/idempotency checks, lease, state → committing, audit
 *   batch   one tx per ≤200 rows for classrooms / progress (creates and updates) and for people updates: renew the
 *           lease, apply, record each row's commit_state + committed_version, audit — all or nothing
 *   people  new teachers / employees: one invitation saga per row (Auth provider calls outside transactions; the
 *           import item is marked applied inside the saga's profile transaction)
 *   finish  one tx: state → completed, lease released, audit
 * A retry (same job; the same Idempotency-Key replays a finished commit, a new key resumes an unfinished one)
 * continues with the rows that have no commit_state yet. A batch that fails unexpectedly is rolled back as a whole
 * and the job becomes `failed` with the batch's row range. A request stops after a time budget and leaves the job
 * in `committing` (lease released) for the next call.
 */
import type { ImportCommitInputT } from "@arms/contracts";
import type { AppContext } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, fail } from "../../http/errors";
import { requireIdempotencyKey } from "../../http/idempotency";
import { audit } from "../admin/common";
import { applyClassrooms, applyPeopleUpdates, applyProgress, insertAudits, isRowConflict, writeCommitResults, type ApplyItem } from "./apply";
import { findJob } from "./jobs";
import { BATCH_SIZE, BatchFailure, LEASE_SECONDS, LeaseLost, REQUEST_BUDGET_MS, recordBatchFailure, releaseLease, renewLease, requestHash, toApiError } from "./lease";
import type { JobRow, JobState } from "./model";
import { createImportedAccount } from "./people";

const COMMITTING: readonly JobState[] = ["committing"];

type Claim = { kind: "replay" } | { kind: "run"; job: JobRow; token: string };

async function claim(c: AppContext, jobId: string, input: ImportCommitInputT): Promise<Claim> {
  const actor = c.get("actor");
  const key = requireIdempotencyKey(c);
  const hash = await requestHash(c, { backup_confirmed: true, send_invitations: input.send_invitations === true });
  return actorTx(c, async (tx) => {
    const job = await findJob(tx, actor.orgId, jobId, { lock: true });
    if (!job) fail("NOT_FOUND");
    if (job.commit_key === key) {
      if (job.commit_hash !== hash) fail("IDEMPOTENCY_CONFLICT");
      if (job.state === "completed" || job.state === "rolled_back") return { kind: "replay" } as const;
    }
    if (job.state === "uploaded") fail("INVALID_STATE", { message_ja: "先にドライランを実行してください。" });
    if (job.state === "completed") fail("INVALID_STATE", { message_ja: "この移行は確定済みです。結果を再読み込みしてください。" });
    if (job.state === "rolled_back" || job.rollback_key !== null) {
      fail("INVALID_STATE", { message_ja: "この移行は取り消し済み（または取り消し中）のため確定できません。新しい移行ジョブを作成してください。" });
    }
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
    return { kind: "run", token, job: { ...job, options, state: "committing" as const, row_version: updated.row_version } } as const;
  });
}

async function nextRows(tx: Tx, orgId: string, jobId: string, filter: "updates" | "creates" | "all"): Promise<ApplyItem[]> {
  const where = filter === "updates" ? sql`action = 'update'` : filter === "creates" ? sql`action = 'create'` : sql`action IN ('create', 'update')`;
  return tx.query<ApplyItem>(sql`
    SELECT row_number, action, entity_id, before_data, after_data FROM app.import_items
    WHERE org_id = ${orgId} AND job_id = ${jobId} AND ${where} AND commit_state IS NULL
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
      range = { from: Math.min(...rows.map((r) => r.row_number)), to: Math.max(...rows.map((r) => r.row_number)) };
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

/** Account creation for imported people, one saga per row. Returns rows processed in this call. */
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
      await createImportedAccount(c, entity, job.id, { row: item.row_number, after: item.after_data }, job.options?.send_invitations === true);
    } catch (e) {
      if (e instanceof LeaseLost) throw e;
      const err = toApiError(e);
      if (!isRowConflict(err)) throw new BatchFailure(err, item.row_number, item.row_number, item.row_number);
      // The row no longer fits the current data (e.g. the e-mail was registered after the dry run). If the saga had
      // already created the profile (marked applied in its transaction) the row stays applied.
      await actorTx(c, async (tx) => {
        await renewLease(tx, actor.orgId, job.id, token, COMMITTING);
        await tx.exec(sql`UPDATE app.import_items SET commit_state = 'conflict', commit_message = ${err.message_ja}, committed_at = now()
          WHERE org_id = ${actor.orgId} AND job_id = ${job.id} AND row_number = ${item.row_number} AND commit_state IS NULL`);
      });
    }
    processed++;
  }
  // Every processed row must now be applied or a conflict; anything else would be retried forever, so it fails the
  // commit (resumable) instead.
  const stuck = await actorTx(c, (tx) =>
    tx.maybeOne<{ row_number: number }>(sql`
      SELECT row_number FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${job.id} AND action = 'create' AND commit_state IS NULL
        AND row_number = ANY(${rows.slice(0, processed).map((r) => r.row_number)}::int[]) ORDER BY row_number LIMIT 1`),
  );
  if (stuck) {
    const err = new ApiError("INTERNAL", { message_ja: "アカウントの作成を完了できなかった行があります。時間をおいて再度確定してください（続きから再開します）。" });
    throw new BatchFailure(err, stuck.row_number, stuck.row_number, stuck.row_number);
  }
  return processed;
}

async function finish(c: AppContext, job: JobRow, token: string): Promise<boolean> {
  const actor = c.get("actor");
  return actorTx(c, async (tx) => {
    await renewLease(tx, actor.orgId, job.id, token, COMMITTING);
    const left = await tx.one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${job.id}
        AND action IN ('create', 'update') AND commit_state IS NULL`);
    if (left.n > 0) return false;
    const counts = await tx.one<{ applied: number; conflict: number }>(sql`
      SELECT count(*) FILTER (WHERE commit_state = 'applied')::int AS applied, count(*) FILTER (WHERE commit_state = 'conflict')::int AS conflict
      FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${job.id}`);
    await tx.exec(sql`
      UPDATE app.import_jobs SET state = 'completed', committed_at = now(), lease_token = NULL, locked_until = NULL, updated_at = now(),
        row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${job.id}`);
    await audit(tx, actor, "import.completed", job.id, { entity: job.entity, source_system: job.source_system, applied: counts.applied, conflict: counts.conflict });
    return true;
  });
}

/**
 * Commits (or resumes) a validated import. Returns when the job is completed, failed (recorded on the job) or the
 * request's time budget is used up (still committing; call again).
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
      if ((await runDataBatch(c, job, token)) > 0) continue;
      if (people && (await runPeopleCreates(c, job, token, deadline)) > 0) continue;
      if (await finish(c, job, token)) return;
    }
  } catch (e) {
    if (e instanceof LeaseLost) fail("IMPORT_IN_PROGRESS");
    if (e instanceof BatchFailure) {
      await recordBatchFailure(c, job, token, e, "import.commit_failed", "failed");
      return;
    }
    throw e;
  }
}
