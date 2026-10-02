import { Hono } from "hono";
import { DeleteAccountInput, PreferenceInput } from "@arms/contracts";
import type { AppEnv, Role } from "../context";
import { actorTx } from "../context";
import { json } from "../db/client";
import { sql } from "../db/sql";
import { fail } from "../http/errors";
import { readBody, requireIfMatch } from "../http/validation";
import { action, ok } from "../http/respond";
import { idempotent } from "../http/idempotency";

export const meRoutes = new Hono<AppEnv>();

/** GET /me — identity, organisation, preferences and (for students) classroom/teacher. */
meRoutes.get("/me", async (c) => {
  const actor = c.get("actor");
  const selected = c.req.header("X-ARMS-Selected-Role") as Role | undefined;
  if (selected && selected !== actor.role) fail("ROLE_MISMATCH");
  const me = await actorTx(c, async (tx) => {
    const base = await tx.one<{ email: string; require_admin_mfa: boolean; timezone: string }>(sql`
      SELECT u.email, o.timezone, coalesce((o.settings->>'require_admin_mfa')::boolean, true) AS require_admin_mfa
      FROM app.users u, app.organizations o WHERE u.id = ${actor.userId} AND o.id = ${actor.orgId}`);
    const pref = await tx.maybeOne<{ theme: "light" | "dark" | "system"; notifications_enabled: boolean; row_version: number }>(sql`
      SELECT theme, notifications_enabled, row_version FROM app.user_preferences WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}`);
    const student =
      actor.role === "student"
        ? await tx.maybeOne(sql`
            SELECT sp.employee_number, sp.classroom_id, c.name AS classroom_name, sp.teacher_id, tu.display_name AS teacher_name, sp.department_name
            FROM app.student_profiles sp
            JOIN app.classrooms c ON c.org_id = sp.org_id AND c.id = sp.classroom_id
            JOIN app.users tu ON tu.id = sp.teacher_id
            WHERE sp.org_id = ${actor.orgId} AND sp.id = ${actor.userId}`)
        : null;
    return { base, pref, student };
  });
  return ok(c, {
    id: actor.userId,
    display_name: actor.displayName,
    email: me.base.email,
    role: actor.role,
    active: true,
    organization: { id: actor.orgId, name: actor.orgName, timezone: me.base.timezone },
    preferences: me.pref ?? { theme: "system", notifications_enabled: true, row_version: 0 },
    student: me.student,
    mfa: { required: actor.role === "admin" && me.base.require_admin_mfa, verified: actor.aal === "aal2" },
  });
});

/** PATCH /me/preferences — theme and notification preference (If-Match: row_version; 0 = not yet saved). */
meRoutes.patch("/me/preferences", async (c) => {
  const actor = c.get("actor");
  const expected = requireIfMatch(c);
  const input = await readBody(c, PreferenceInput);
  const saved = await actorTx(c, async (tx) => {
    if (expected === 0) {
      const inserted = await tx.maybeOne<{ row_version: number }>(sql`
        INSERT INTO app.user_preferences(org_id, user_id, theme, notifications_enabled)
        VALUES (${actor.orgId}, ${actor.userId}, ${input.theme}, ${input.notifications_enabled})
        ON CONFLICT DO NOTHING RETURNING row_version`);
      if (!inserted) fail("VERSION_CONFLICT");
      return inserted;
    }
    const updated = await tx.maybeOne<{ row_version: number }>(sql`
      UPDATE app.user_preferences SET theme = ${input.theme}, notifications_enabled = ${input.notifications_enabled}, row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND row_version = ${expected} RETURNING row_version`);
    if (!updated) fail("VERSION_CONFLICT");
    return updated;
  });
  c.header("ETag", `"${saved.row_version}"`);
  return action(c, { theme: input.theme, notifications_enabled: input.notifications_enabled, row_version: saved.row_version });
});

/** POST /me/account-deletion — records a deletion request for administrator review (App Store requirement). */
meRoutes.post("/me/account-deletion", async (c) => {
  const actor = c.get("actor");
  const input = await readBody(c, DeleteAccountInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const open = await tx.maybeOne<{ id: string; state: string }>(sql`
        SELECT id, state FROM app.account_deletion_requests
        WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND state <> 'completed'`);
      if (open) return { status: 200, body: { request_id: open.id, state: open.state } };
      const created = await tx.one<{ id: string; state: string }>(sql`
        INSERT INTO app.account_deletion_requests(org_id, user_id, reason, state)
        VALUES (${actor.orgId}, ${actor.userId}, ${input.reason ?? ""}, 'requested') RETURNING id, state`);
      await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
        VALUES (${actor.orgId}, ${actor.userId}, 'account.deletion_requested', ${created.id}, ${json({ user_id: actor.userId })}::jsonb)`);
      await tx.exec(sql`INSERT INTO app.outbox(org_id, event_type, entity_id, payload)
        VALUES (${actor.orgId}, 'account.deletion_requested', ${created.id}, ${json({ user_id: actor.userId })}::jsonb)`);
      return { status: 200, body: { request_id: created.id, state: created.state } };
    }),
  );
  return action(c, result.body);
});
