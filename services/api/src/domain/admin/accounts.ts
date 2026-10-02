/**
 * Account (membership) activation rules shared by teacher/student archive, user management and account-deletion
 * completion. The DB membership is authoritative: the API rejects inactive memberships on every request, and
 * stopping an account ends its Web sessions in the organisation and its iOS sessions in the same transaction.
 */
import type { Actor, Role } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { fail } from "../../http/errors";
import { revokeUserSessions } from "../../auth/session";
import { revokeUserBearerSessions } from "../../auth/tokens";
import { primaryClassroomsOf, upcomingSlotCount } from "../../repositories/admin/teachers";

export interface MembershipTarget {
  id: string;
  role: Role;
  active: boolean;
}

/**
 * Locks and returns the membership of a user in the actor's organisation (404 when absent).
 * For an admin target every active admin membership is locked in id order first, so concurrent
 * "disable each other" requests serialise without deadlocking and the last-admin check is reliable.
 */
export async function lockMembership(tx: Tx, orgId: string, userId: string): Promise<MembershipTarget> {
  const peek = await tx.maybeOne<MembershipTarget>(sql`SELECT id, role, active FROM app.memberships WHERE org_id = ${orgId} AND id = ${userId}`);
  if (!peek) fail("NOT_FOUND");
  if (peek.role === "admin") {
    await tx.query(sql`SELECT id FROM app.memberships WHERE org_id = ${orgId} AND role = 'admin' AND (active OR id = ${userId}) ORDER BY id FOR NO KEY UPDATE`);
  } else {
    await tx.query(sql`SELECT id FROM app.memberships WHERE org_id = ${orgId} AND id = ${userId} FOR NO KEY UPDATE`);
  }
  return tx.one<MembershipTarget>(sql`SELECT id, role, active FROM app.memberships WHERE org_id = ${orgId} AND id = ${userId}`);
}

/** A teacher can be stopped only when not primary teacher of an open classroom and without upcoming lesson slots. */
export async function assertTeacherReleasable(tx: Tx, orgId: string, teacherId: string): Promise<void> {
  const primary = await primaryClassroomsOf(tx, orgId, teacherId);
  if (primary.length > 0) fail("TEACHER_IS_PRIMARY", { details: { classrooms: primary } });
  const slots = await upcomingSlotCount(tx, orgId, teacherId);
  if (slots > 0) fail("TEACHER_HAS_FUTURE_SLOTS", { details: { upcoming_slot_count: slots } });
}

/** Guards that apply to every way of stopping an account. */
export async function assertCanDeactivate(tx: Tx, actor: Actor, target: MembershipTarget): Promise<void> {
  if (target.id === actor.userId) fail("CANNOT_DISABLE_SELF");
  if (target.role === "admin") {
    // Admin memberships were locked by lockMembership(), so this count cannot change before commit.
    const admins = await tx.query<{ id: string }>(sql`SELECT id FROM app.memberships WHERE org_id = ${actor.orgId} AND role = 'admin' AND active`);
    if (!admins.some((a) => a.id !== target.id)) fail("LAST_ADMIN");
  }
  if (target.role === "teacher") await assertTeacherReleasable(tx, actor.orgId, target.id);
}

/**
 * Sets membership.active. Deactivation revokes the user's Web sessions in this organisation and all of the user's
 * iOS sessions (bearer tokens are not organisation-bound; a user active elsewhere simply signs in again).
 * Caller has run the guards.
 */
export async function setMembershipActive(tx: Tx, orgId: string, userId: string, active: boolean): Promise<void> {
  await tx.exec(sql`
    UPDATE app.memberships SET active = ${active}, disabled_at = CASE WHEN ${active}::boolean THEN NULL ELSE now() END, row_version = row_version + 1
    WHERE org_id = ${orgId} AND id = ${userId}`);
  if (!active) {
    await revokeUserSessions(tx, orgId, userId);
    await revokeUserBearerSessions(tx, userId, "account_disabled", new Date());
  }
}
