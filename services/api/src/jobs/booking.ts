/**
 * Booking cron (every minute): per organisation, (1) expire due pending reservations under the slot lock and
 * (2) dispatch due outbox rows — the fallback for queue messages that were never sent, lost or retried.
 * Each organisation runs with its own tenant context; one organisation's failure does not stop the others.
 */
import type { Deps } from "../context";
import { RequestDb } from "../db/client";
import { sql } from "../db/sql";
import { expireDuePendings } from "../domain/booking/expiry";
import { dispatchDueOutbox } from "../domain/notifications/dispatch";

const OUTBOX_ROWS_PER_ORG = 50;

export async function listOrganizationIds(deps: Deps): Promise<string[]> {
  const db = new RequestDb(deps.connections);
  try {
    const rows = await db.tx({}, (tx) => tx.query<{ id: string }>(sql`SELECT id FROM app.organizations ORDER BY id`));
    return rows.map((r) => r.id);
  } finally {
    await db.close();
  }
}

/** `opts.orgIds` restricts the run to the given organisations (operations/tests); default: all. */
export async function runBookingJobs(deps: Deps, opts: { orgIds?: readonly string[] } = {}): Promise<void> {
  const orgIds = opts.orgIds ?? (await listOrganizationIds(deps));
  for (const orgId of orgIds) {
    try {
      const expired = await expireDuePendings(deps, orgId);
      if (expired.reservations > 0) deps.log({ level: "info", msg: "pending_expired", org_id: orgId, slots: expired.slots, reservations: expired.reservations });
    } catch (e) {
      const err = e as { name?: string; code?: string };
      deps.log({ level: "error", msg: "pending_expiry_job_failed", org_id: orgId, error_name: err?.name, error_code: err?.code });
    }
    try {
      await dispatchDueOutbox(deps, orgId, OUTBOX_ROWS_PER_ORG);
    } catch (e) {
      const err = e as { name?: string; code?: string };
      deps.log({ level: "error", msg: "outbox_dispatch_job_failed", org_id: orgId, error_name: err?.name, error_code: err?.code });
    }
  }
}
