import type { Deps } from "../context";
import { RequestDb } from "../db/client";
import { sql } from "../db/sql";

/**
 * Housekeeping (every minute, cheap no-ops when nothing is due):
 * - Web and iOS (bearer) sessions expired/revoked more than 7 days ago are deleted (hashes + ciphertext only)
 * - one-time e-mail link tokens are deleted one day after they expired
 * - idempotency records are kept 24 h (expires_at) and then deleted one day later, per organisation (RLS context)
 */
export async function runAdminJobs(deps: Deps): Promise<void> {
  const db = new RequestDb(deps.connections);
  try {
    await db.tx({}, async (tx) => {
      await tx.exec(sql`DELETE FROM app.web_sessions
        WHERE (expires_at < now() - interval '7 days') OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`);
      await tx.exec(sql`DELETE FROM app.bearer_sessions
        WHERE (expires_at < now() - interval '7 days') OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`);
      await tx.exec(sql`DELETE FROM app.auth_link_tokens WHERE expires_at < now() - interval '1 day'`);
    });
    const orgs = await db.tx({}, (tx) => tx.query<{ id: string }>(sql`SELECT id FROM app.organizations ORDER BY id`));
    for (const org of orgs) {
      try {
        await db.tx({ orgId: org.id }, (tx) =>
          tx.exec(sql`DELETE FROM app.idempotency_requests WHERE org_id = ${org.id} AND expires_at < now() - interval '1 day'`),
        );
      } catch (e) {
        const err = e as { name?: string; code?: string };
        deps.log({ level: "error", msg: "admin_job_failed", org_id: org.id, error_name: err?.name, error_code: err?.code });
      }
    }
  } finally {
    await db.close();
  }
}
