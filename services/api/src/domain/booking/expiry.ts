/**
 * Minute-cron pending expiry (docs/04 「期限切れcron1分＋申請/判断時のlazy expiry」).
 * For one organisation: find slots with due pending holds and expire them one slot per transaction, in
 * slot-id order, each under the slot row lock (FOR UPDATE) via app.expire_slot — the same lock that
 * serialises booking and decisions. Deadlocks/serialisation failures are retried a bounded number of times
 * by RequestDb.tx; a slot that still fails is logged and picked up by the next run.
 */
import type { Deps } from "../../context";
import { RequestDb } from "../../db/client";
import { sql } from "../../db/sql";

export async function expireDuePendings(deps: Deps, orgId: string, limit = 200): Promise<{ slots: number; reservations: number }> {
  const db = new RequestDb(deps.connections);
  let reservations = 0;
  let slots = 0;
  try {
    const due = await db.tx({ orgId }, (tx) =>
      tx.query<{ slot_id: string }>(sql`
        SELECT DISTINCT slot_id FROM app.reservations
        WHERE org_id = ${orgId} AND status = 'pending' AND expires_at <= now()
        ORDER BY slot_id LIMIT ${limit}`),
    );
    for (const { slot_id } of due) {
      try {
        const n = await db.tx(
          { orgId },
          async (tx) => {
            await tx.query(sql`SELECT id FROM app.lesson_slots WHERE org_id = ${orgId} AND id = ${slot_id} FOR UPDATE`);
            const before = await tx.one<{ n: number }>(sql`
              SELECT count(*)::int AS n FROM app.reservations WHERE org_id = ${orgId} AND slot_id = ${slot_id} AND status = 'pending' AND expires_at <= now()`);
            await tx.query(sql`SELECT app.expire_slot(${slot_id})`);
            return before.n;
          },
          { retries: 3 },
        );
        reservations += n;
        slots += 1;
      } catch (e) {
        const err = e as { name?: string; code?: string };
        deps.log({ level: "error", msg: "pending_expiry_failed", org_id: orgId, slot_id, error_name: err?.name, error_code: err?.code });
      }
    }
  } finally {
    await db.close();
  }
  return { slots, reservations };
}
