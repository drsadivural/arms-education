/**
 * WEB-18 ユーザー管理: accounts, administrator invitations, stop/resume, invitation resend and
 * account-deletion requests (POST /me/account-deletion).
 *
 * Decision: POST /settings/users/invite creates administrator accounts only. Teachers and students need a
 * profile (講師番号 / 社員番号・クラス・担当講師…) and are invited from 講師管理 / 新入社員管理 (POST /teachers, POST /students),
 * which run the same invitation saga.
 */
import { Hono } from "hono";
import { z } from "zod";
import { UserInvite, type User } from "@arms/contracts";
import type { AppContext, AppEnv, Role } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { and, sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { fail } from "../../http/errors";
import { pathId, readBody, readQuery } from "../../http/validation";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { action, ok, page } from "../../http/respond";
import { TimeIdCursor, audit, containsPattern, optionalQuery, zQueryText } from "../../domain/admin/common";
import { resendInvitation, runInvitation } from "../../domain/admin/invitations";
import { assertCanDeactivate, lockMembership, setMembershipActive, syncProviderBan } from "../../domain/admin/accounts";

export const userRoutes = new Hono<AppEnv>();

const UserListQuery = z.object({
  cursor: optionalQuery(z.string().max(1000)),
  limit: optionalQuery(z.string()),
  q: optionalQuery(zQueryText),
  role: optionalQuery(z.enum(["admin", "teacher", "student"])),
  status: optionalQuery(z.enum(["active", "inactive", "invite_failed"])),
});

interface UserRow extends User {
  cursor_t: string;
}

userRoutes.get("/settings/users", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const query = readQuery(c, UserListQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, TimeIdCursor);
  const like = query.q ? containsPattern(query.q) : null;
  const rows = await actorTx(c, (tx) =>
    tx.query<UserRow>(sql`
      SELECT u.id, u.display_name, u.email, m.role, m.active, inv.state AS invitation_state, m.created_at, m.created_at::text AS cursor_t
      FROM app.memberships m
      JOIN app.users u ON u.id = m.id
      LEFT JOIN LATERAL (
        SELECT j.state FROM app.invitation_jobs j WHERE j.org_id = m.org_id AND j.auth_user_id = m.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1
      ) inv ON true
      WHERE ${and([
        sql`m.org_id = ${actor.orgId}`,
        like ? sql`(u.display_name ILIKE ${like} ESCAPE '\\' OR u.email ILIKE ${like} ESCAPE '\\')` : null,
        query.role ? sql`m.role = ${query.role}` : null,
        query.status === "active" ? sql`m.active` : null,
        query.status === "inactive" ? sql`NOT m.active` : null,
        query.status === "invite_failed" ? sql`inv.state = 'failed'` : null,
        after ? sql`(m.created_at, m.id) < (${after.t}::timestamptz, ${after.id}::uuid)` : null,
      ])}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1}`),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ t: r.cursor_t, id: r.id }));
  return page(
    c,
    items.map(({ cursor_t: _cursor, ...u }) => u),
    nextCursor,
  );
});

/** Administrator invitation (saga with invitation_jobs). Teacher/student roles are directed to their forms. */
userRoutes.post("/settings/users/invite", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const input = await readBody(c, UserInvite);
  if (input.role !== "admin") {
    fail("VALIDATION_FAILED", {
      field_errors: {
        role:
          input.role === "teacher"
            ? "講師は講師番号などのプロフィールが必要なため、「講師管理」から登録してください。"
            : "新入社員は社員番号・クラス・担当講師が必要なため、「新入社員管理」から登録してください。",
      },
    });
  }
  const payload = { email: input.email.trim(), display_name: input.display_name, role: "admin" as const };
  const outcome = await runInvitation(c, {
    email: payload.email,
    role: "admin",
    displayName: payload.display_name,
    payload,
    async precheck(tx) {
      const taken = await tx.maybeOne(sql`SELECT 1 FROM app.users WHERE lower(email) = lower(${payload.email})`);
      if (taken) fail("EMAIL_TAKEN", { field_errors: { email: "このメールアドレスは既に登録されています。" } });
    },
    async createProfile(tx, stored, userId) {
      const p = stored as typeof payload;
      await tx.exec(sql`INSERT INTO app.users(id, display_name, email) VALUES (${userId}, ${p.display_name}, ${p.email})`);
      await tx.exec(sql`INSERT INTO app.memberships(org_id, id, role, active) VALUES (${actor.orgId}, ${userId}, 'admin', true)`);
      await audit(tx, actor, "user.invited", userId, { role: "admin" });
    },
  });
  return ok(c, outcome.result);
});

userRoutes.post("/settings/users/:id/resend-invite", requireRole("admin"), async (c) => {
  const id = pathId(c);
  const result = await resendInvitation(c, id);
  return action(c, { invitation: result });
});

async function disableAccount(tx: Tx, c: AppContext, userId: string): Promise<{ changed: boolean; role: Role }> {
  const actor = c.get("actor");
  const target = await lockMembership(tx, actor.orgId, userId);
  if (!target.active) return { changed: false, role: target.role };
  await assertCanDeactivate(tx, actor, target);
  await setMembershipActive(tx, actor.orgId, userId, false);
  return { changed: true, role: target.role };
}

/** Stop: membership inactive + web sessions revoked (same transaction) + provider sign-in blocked (after commit). */
userRoutes.post("/settings/users/:id/disable", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const result = await actorTx(c, async (tx) => {
    const r = await disableAccount(tx, c, id);
    if (r.changed) await audit(tx, actor, "user.disabled", id, { role: r.role });
    return r;
  });
  const sync = result.changed ? await syncProviderBan(c, id, true) : { provider_synced: true };
  return action(c, { id, active: false, changed: result.changed, ...sync });
});

userRoutes.post("/settings/users/:id/enable", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const result = await actorTx(c, async (tx) => {
    const target = await lockMembership(tx, actor.orgId, id);
    if (target.active) return { changed: false };
    await setMembershipActive(tx, actor.orgId, id, true);
    await audit(tx, actor, "user.enabled", id, { role: target.role });
    return { changed: true };
  });
  const sync = result.changed ? await syncProviderBan(c, id, false) : { provider_synced: true };
  return action(c, { id, active: true, changed: result.changed, ...sync });
});

const DeletionListQuery = z.object({
  cursor: optionalQuery(z.string().max(1000)),
  limit: optionalQuery(z.string()),
  state: optionalQuery(z.enum(["requested", "reviewing", "completed"])),
});

userRoutes.get("/settings/account-deletion-requests", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const query = readQuery(c, DeletionListQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, TimeIdCursor);
  const rows = await actorTx(c, (tx) =>
    tx.query<{ id: string; created_at: Date; cursor_t: string }>(sql`
      SELECT r.id, r.user_id, u.display_name, u.email, m.role, m.active AS user_active, r.reason, r.state, r.created_at, r.created_at::text AS cursor_t
      FROM app.account_deletion_requests r
      JOIN app.memberships m ON m.org_id = r.org_id AND m.id = r.user_id
      JOIN app.users u ON u.id = r.user_id
      WHERE ${and([
        sql`r.org_id = ${actor.orgId}`,
        query.state ? sql`r.state = ${query.state}` : null,
        after ? sql`(r.created_at, r.id) < (${after.t}::timestamptz, ${after.id}::uuid)` : null,
      ])}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ t: r.cursor_t, id: r.id }));
  return page(
    c,
    items.map(({ cursor_t: _cursor, ...r }) => r),
    nextCursor,
  );
});

/** Completes a deletion request: the account is stopped (training records are kept for the organisation). */
userRoutes.post("/settings/account-deletion-requests/:id/complete", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const result = await actorTx(c, async (tx) => {
    const request = await tx.maybeOne<{ user_id: string; state: string }>(sql`
      SELECT user_id, state FROM app.account_deletion_requests WHERE org_id = ${actor.orgId} AND id = ${id} FOR UPDATE`);
    if (!request) fail("NOT_FOUND");
    if (request.state === "completed") return { userId: request.user_id, changed: false, alreadyCompleted: true };
    const disabled = await disableAccount(tx, c, request.user_id);
    await tx.exec(sql`UPDATE app.account_deletion_requests SET state = 'completed' WHERE org_id = ${actor.orgId} AND id = ${id}`);
    await audit(tx, actor, "account.deletion_completed", id, { user_id: request.user_id, role: disabled.role, account_disabled: disabled.changed });
    return { userId: request.user_id, changed: disabled.changed, alreadyCompleted: false };
  });
  const sync = result.changed ? await syncProviderBan(c, result.userId, true) : { provider_synced: true };
  return action(c, { id, user_id: result.userId, state: "completed", already_completed: result.alreadyCompleted, ...sync });
});

