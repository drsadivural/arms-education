/**
 * Account (membership) activation rules shared by teacher/student archive, user management and account-deletion
 * completion. The DB membership is authoritative (the API rejects inactive memberships on every request);
 * the Auth provider ban is synchronised after the transaction commits.
 */
import type { Actor, AppContext, Role } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, fail } from "../../http/errors";
import { revokeUserSessions } from "../../auth/session";
import { membershipsOf } from "../../auth/middleware";
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

/** Sets membership.active, revoking web sessions on deactivation. Caller has run the guards. */
export async function setMembershipActive(tx: Tx, orgId: string, userId: string, active: boolean): Promise<void> {
  await tx.exec(sql`
    UPDATE app.memberships SET active = ${active}, disabled_at = CASE WHEN ${active}::boolean THEN NULL ELSE now() END, row_version = row_version + 1
    WHERE org_id = ${orgId} AND id = ${userId}`);
  if (!active) await revokeUserSessions(tx, orgId, userId);
}

export interface ProviderSync {
  provider_synced: boolean;
  message_ja?: string;
}

/**
 * Blocks/unblocks sign-in at the Auth provider after the DB change committed. A ban is skipped when the account
 * still has an active membership in another organisation (the provider account is shared across organisations).
 * Failures do not undo the DB change (access is already denied by the membership check); they are reported.
 */
export async function syncProviderBan(c: AppContext, userId: string, banned: boolean): Promise<ProviderSync> {
  const deps = c.get("deps");
  const actor = c.get("actor");
  if (banned) {
    // Authentication-bootstrap visibility of the target's own memberships (app.auth_user_id), used only to decide
    // whether the shared provider account may be banned; nothing from other organisations is returned to clients.
    const memberships = await c.get("db").tx({ authUserId: userId }, (tx) => membershipsOf(tx, userId));
    if (memberships.some((m) => m.org_id !== actor.orgId && m.active)) {
      return { provider_synced: true, message_ja: "他の組織で有効なため、認証サービスのログイン停止は行っていません（この組織では利用できません）。" };
    }
  }
  try {
    await deps.auth.adminSetBanned(userId, banned);
    return { provider_synced: true };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "INTERNAL";
    deps.log({ level: "warn", msg: "provider_ban_sync_failed", request_id: c.get("requestId"), user_id: userId, banned, code });
    return {
      provider_synced: false,
      message_ja: banned
        ? "アカウントは停止しましたが、認証サービスへの反映に失敗しました（この組織のAPIは利用できません）。時間をおいて再度操作してください。"
        : "アカウントは再開しましたが、認証サービスへの反映に失敗しました。時間をおいて再度操作してください。",
    };
  }
}
