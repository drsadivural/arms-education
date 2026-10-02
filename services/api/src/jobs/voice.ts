import type { Deps } from "../context";
import { RequestDb } from "../db/client";
import { sql } from "../db/sql";

/**
 * Voice housekeeping per organisation:
 * - sessions past expiry without an end call are closed and charged their full reservation (no under-counting)
 * - confirmation drafts (hashed action tokens) are deleted a day after expiry; consumed results stay with the
 *   reservation's own audit trail, so nothing business-relevant is lost
 */
export async function runVoiceJobs(deps: Deps): Promise<void> {
  const db = new RequestDb(deps.connections);
  try {
    const orgs = await db.tx({}, (tx) => tx.query<{ id: string }>(sql`SELECT id FROM app.organizations ORDER BY id`));
    for (const org of orgs) {
      try {
        await db.tx({ orgId: org.id }, async (tx) => {
          await tx.exec(sql`UPDATE app.voice_sessions SET ended_at = expires_at, consumed_seconds = reserved_seconds, end_reason = 'expired'
            WHERE org_id = ${org.id} AND ended_at IS NULL AND expires_at < now() - interval '2 minutes'`);
          await tx.exec(sql`DELETE FROM app.voice_actions WHERE org_id = ${org.id} AND expires_at < now() - interval '1 day'`);
        });
      } catch (e) {
        const err = e as { name?: string; code?: string };
        deps.log({ level: "error", msg: "voice_job_failed", org_id: org.id, error_name: err?.name, error_code: err?.code });
      }
    }
  } finally {
    await db.close();
  }
}
