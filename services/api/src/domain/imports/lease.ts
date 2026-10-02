/**
 * Job lease shared by commit and rollback. A request that claims a job stores a random lease token with an expiry;
 * every batch transaction renews it (and fails with LeaseLost when another request took the job over after the
 * lease expired). Requests stop after a time budget and release the lease; the client calls again to continue.
 */
import type { AppContext } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, mapDbError } from "../../http/errors";
import { sha256Hex } from "../../auth/crypto";
import { audit, stableStringify } from "../admin/common";
import type { JobRow, JobState } from "./model";

export const BATCH_SIZE = 200;
export const LEASE_SECONDS = 120;
/** Wall-clock budget of one commit/rollback request (Workers request duration); the job is resumable afterwards. */
export const REQUEST_BUDGET_MS = 20_000;

export class LeaseLost extends Error {}

/** A batch that failed as a whole (rolled back); reported on the job with its row range. */
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

export async function renewLease(tx: Tx, orgId: string, jobId: string, token: string, states: readonly JobState[]): Promise<void> {
  const ok = await tx.maybeOne(sql`
    UPDATE app.import_jobs SET locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
    WHERE org_id = ${orgId} AND id = ${jobId} AND lease_token = ${token} AND state = ANY(${states}::text[])
    RETURNING id`);
  if (!ok) throw new LeaseLost();
}

export async function releaseLease(c: AppContext, jobId: string, token: string): Promise<void> {
  const actor = c.get("actor");
  await actorTx(c, (tx) =>
    tx.exec(sql`UPDATE app.import_jobs SET lease_token = NULL, locked_until = NULL, updated_at = now()
      WHERE org_id = ${actor.orgId} AND id = ${jobId} AND lease_token = ${token}`),
  );
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return mapDbError(e) ?? new ApiError("INTERNAL", { cause: e });
}

export async function requestHash(c: AppContext, body: unknown): Promise<string> {
  return sha256Hex(stableStringify({ route: `${c.req.method} ${c.req.path}`, request: body }));
}

/**
 * Records a failed batch on the job (failure with the batch's row range; `state` when given) and releases the
 * lease. The audit event names the phase (import.commit_failed / import.rollback_failed).
 */
export async function recordBatchFailure(
  c: AppContext,
  job: Pick<JobRow, "id">,
  token: string,
  failure: BatchFailure,
  eventType: string,
  state: JobState | null,
): Promise<void> {
  const actor = c.get("actor");
  const err = failure.error;
  c.get("deps").log({
    level: err.status >= 500 ? "error" : "warn",
    msg: "import_batch_failed",
    request_id: c.get("requestId"),
    job_id: job.id,
    phase: eventType,
    code: err.code,
    from_row: failure.fromRow,
    to_row: failure.toRow,
  });
  const body = { code: err.code, message_ja: err.message_ja, from_row: failure.fromRow, to_row: failure.toRow, row: failure.row };
  try {
    await actorTx(c, async (tx) => {
      const n = await tx.exec(sql`
        UPDATE app.import_jobs SET state = coalesce(${state}::text, state), failure = ${json(body)}::jsonb, lease_token = NULL, locked_until = NULL,
          updated_at = now(), row_version = row_version + 1
        WHERE org_id = ${actor.orgId} AND id = ${job.id} AND lease_token = ${token}`);
      if (n === 1) await audit(tx, actor, eventType, job.id, body);
    });
  } catch {
    // The database itself is unavailable: report the original error (the lease expires by itself).
    throw err;
  }
}
