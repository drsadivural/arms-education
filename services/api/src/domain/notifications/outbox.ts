/**
 * Outbox helpers for writers. Business transactions insert app.outbox rows (directly or through the booking
 * SQL functions); after COMMIT the API wakes the dispatcher through the notification queue, best-effort:
 * a failed enqueue never fails the request — the minute cron dispatches every due row anyway.
 */
import type { Context } from "hono";
import type { Deps } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";

/**
 * Outbox rows inserted by the current transaction. `created_at` defaults to now(), which is the transaction
 * start time, so rows of this transaction share it. (A concurrent transaction starting in the very same
 * microsecond could be included too; the dispatcher's claim makes that harmless.)
 */
export async function newOutboxIds(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(sql`
    SELECT id FROM app.outbox WHERE org_id = ${orgId} AND created_at = now() AND state = 'pending' ORDER BY id`);
  return rows.map((r) => r.id);
}

/** Enqueues {org_id, outbox_id} messages. Never throws. */
export async function enqueueOutbox(deps: Deps, orgId: string, outboxIds: readonly string[]): Promise<void> {
  const queue = deps.integrations.queue;
  if (!queue || outboxIds.length === 0) return;
  try {
    await queue.enqueueBatch(outboxIds.map((id) => ({ org_id: orgId, outbox_id: id })));
  } catch (e) {
    const err = e as { name?: string };
    deps.log({ level: "warn", msg: "outbox_enqueue_failed", org_id: orgId, count: outboxIds.length, error_name: err?.name });
  }
}

/**
 * After-commit wake-up from a request handler: uses waitUntil in Workers so the response is not delayed,
 * and awaits inline where no ExecutionContext exists (tests, scripts).
 */
export async function enqueueAfterCommit(c: Context, deps: Deps, orgId: string, outboxIds: readonly string[]): Promise<void> {
  if (outboxIds.length === 0 || !deps.integrations.queue) return;
  const p = enqueueOutbox(deps, orgId, outboxIds);
  let executionCtx: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = null;
  }
  if (executionCtx) executionCtx.waitUntil(p);
  else await p;
}
