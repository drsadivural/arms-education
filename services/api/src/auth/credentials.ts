/**
 * Credentials in PostgreSQL (app.user_credentials): password sign-in with lockout, password changes and the
 * administrator TOTP factor. Every function runs inside the caller's transaction.
 */
import type { Tx } from "../db/client";
import { sql } from "../db/sql";
import { ApiError, fail } from "../http/errors";
import { decryptString, encryptString } from "./crypto";
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from "./password";
import { generateTotpSecret, verifyTotp } from "./totp";

/** Consecutive failures before the account is locked, and the lock duration. */
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_SECONDS = 15 * 60;
/** A QR code shown for enrollment must be confirmed within this time. */
export const TOTP_ENROLLMENT_SECONDS = 15 * 60;

const LOCKED_MESSAGE = "ログインの失敗が続いたため、一時的にログインを制限しています。15分ほど待ってから再度お試しいただくか、パスワードを再設定してください。";

export type LoginCheck = { ok: true; userId: string } | { ok: false; error: ApiError };

/**
 * Checks e-mail + password. Unknown addresses, accounts without a password and wrong passwords all give the same
 * INVALID_CREDENTIALS after the same amount of hashing work. Failures are returned (not thrown) so the caller can
 * commit the failure counter before answering; reaching LOCKOUT_THRESHOLD locks the account for LOCKOUT_SECONDS.
 */
export async function checkLogin(tx: Tx, email: string, password: string, now: Date): Promise<LoginCheck> {
  const user = await tx.maybeOne<{ id: string }>(sql`SELECT id FROM app.users WHERE lower(email) = lower(${email})`);
  const cred = user
    ? await tx.maybeOne<{ password_hash: string | null; failed_login_count: number; locked_until: Date | null }>(sql`
        SELECT password_hash, failed_login_count, locked_until FROM app.user_credentials WHERE user_id = ${user.id} FOR UPDATE`)
    : null;
  if (!user || !cred?.password_hash) {
    await burnPasswordCheck(password);
    return { ok: false, error: new ApiError("INVALID_CREDENTIALS") };
  }
  if (cred.locked_until && new Date(cred.locked_until) > now) {
    await burnPasswordCheck(password);
    return { ok: false, error: new ApiError("RATE_LIMITED", { message_ja: LOCKED_MESSAGE }) };
  }
  if (!(await verifyPassword(password, cred.password_hash))) {
    const failures = cred.failed_login_count + 1;
    const locked = failures >= LOCKOUT_THRESHOLD;
    await tx.exec(sql`
      UPDATE app.user_credentials SET
        failed_login_count = ${locked ? 0 : failures},
        locked_until = ${locked ? new Date(now.getTime() + LOCKOUT_SECONDS * 1000) : null},
        updated_at = ${now}
      WHERE user_id = ${user.id}`);
    return { ok: false, error: locked ? new ApiError("RATE_LIMITED", { message_ja: LOCKED_MESSAGE }) : new ApiError("INVALID_CREDENTIALS") };
  }
  const rehash = needsRehash(cred.password_hash) ? await hashPassword(password) : null;
  await tx.exec(sql`
    UPDATE app.user_credentials SET failed_login_count = 0, locked_until = NULL,
      password_hash = coalesce(${rehash}, password_hash), updated_at = ${now}
    WHERE user_id = ${user.id}`);
  return { ok: true, userId: user.id };
}

export async function hasPassword(tx: Tx, userId: string): Promise<boolean> {
  const row = await tx.maybeOne<{ has: boolean }>(sql`SELECT password_hash IS NOT NULL AS has FROM app.user_credentials WHERE user_id = ${userId}`);
  return row?.has ?? false;
}

/** Sets a new password (invitation / reset link) and clears any lockout. */
export async function setPassword(tx: Tx, userId: string, password: string, now: Date): Promise<void> {
  const hash = await hashPassword(password);
  await tx.exec(sql`
    INSERT INTO app.user_credentials(user_id, password_hash, password_changed_at, created_at, updated_at)
    VALUES (${userId}, ${hash}, ${now}, ${now}, ${now})
    ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = EXCLUDED.password_changed_at,
      failed_login_count = 0, locked_until = NULL, updated_at = EXCLUDED.updated_at`);
}

export async function totpEnrolled(tx: Tx, userId: string): Promise<boolean> {
  const row = await tx.maybeOne<{ enrolled: boolean }>(sql`SELECT totp_enrolled_at IS NOT NULL AS enrolled FROM app.user_credentials WHERE user_id = ${userId}`);
  return row?.enrolled ?? false;
}

const totpAad = (userId: string) => `totp:${userId}`;

/** Starts enrollment: a new pending secret (replacing an unconfirmed one). Fails when a factor is already enrolled. */
export async function beginTotpEnrollment(tx: Tx, key: string, userId: string, now: Date): Promise<string> {
  if (await totpEnrolled(tx, userId)) fail("INVALID_STATE", { message_ja: "二段階認証は登録済みです。認証コードを入力してください。" });
  const secret = generateTotpSecret();
  const enc = await encryptString(key, secret, totpAad(userId));
  await tx.exec(sql`
    INSERT INTO app.user_credentials(user_id, totp_pending_secret_enc, totp_pending_created_at, created_at, updated_at)
    VALUES (${userId}, ${enc}, ${now}, ${now}, ${now})
    ON CONFLICT (user_id) DO UPDATE SET totp_pending_secret_enc = EXCLUDED.totp_pending_secret_enc,
      totp_pending_created_at = EXCLUDED.totp_pending_created_at, updated_at = EXCLUDED.updated_at`);
  return secret;
}

/**
 * Verifies a TOTP code against the enrolled factor, or confirms the pending one (first verification completes
 * enrollment). Returns whether this call completed an enrollment.
 */
export async function verifyTotpCode(tx: Tx, key: string, userId: string, code: string, now: Date): Promise<{ enrolledNow: boolean }> {
  const row = await tx.maybeOne<{
    totp_secret_enc: string | null;
    totp_pending_secret_enc: string | null;
    totp_pending_created_at: Date | null;
    totp_last_step: string | null;
  }>(sql`SELECT totp_secret_enc, totp_pending_secret_enc, totp_pending_created_at, totp_last_step FROM app.user_credentials WHERE user_id = ${userId} FOR UPDATE`);
  const enrolled = row?.totp_secret_enc ?? null;
  const pendingFresh =
    row?.totp_pending_secret_enc && row.totp_pending_created_at && now.getTime() - new Date(row.totp_pending_created_at).getTime() <= TOTP_ENROLLMENT_SECONDS * 1000;
  if (!enrolled && !row?.totp_pending_secret_enc) fail("INVALID_STATE", { message_ja: "二段階認証が登録されていません。" });
  if (!enrolled && !pendingFresh) {
    fail("INVALID_STATE", { message_ja: "登録用QRコードの有効期限（15分）が切れました。もう一度QRコードを表示して登録してください。" });
  }
  const secret = await decryptString(key, (enrolled ?? row?.totp_pending_secret_enc) as string, totpAad(userId));
  const step = await verifyTotp(secret, code, now.getTime(), row?.totp_last_step == null ? null : Number(row.totp_last_step));
  if (step === null) fail("VALIDATION_FAILED", { message_ja: "認証コードが正しくありません。", field_errors: { code: "認証コードが正しくありません。" } });
  if (enrolled) {
    await tx.exec(sql`UPDATE app.user_credentials SET totp_last_step = ${step}, updated_at = ${now} WHERE user_id = ${userId}`);
    return { enrolledNow: false };
  }
  await tx.exec(sql`
    UPDATE app.user_credentials SET totp_secret_enc = totp_pending_secret_enc, totp_enrolled_at = ${now},
      totp_pending_secret_enc = NULL, totp_pending_created_at = NULL, totp_last_step = ${step}, updated_at = ${now}
    WHERE user_id = ${userId}`);
  return { enrolledNow: true };
}

/** Removes the TOTP factor (administrator reset of a lost authenticator). Returns whether one was enrolled. */
export async function resetTotp(tx: Tx, userId: string, now: Date): Promise<boolean> {
  const had = await totpEnrolled(tx, userId);
  await tx.exec(sql`
    UPDATE app.user_credentials SET totp_secret_enc = NULL, totp_enrolled_at = NULL, totp_pending_secret_enc = NULL,
      totp_pending_created_at = NULL, totp_last_step = NULL, updated_at = ${now}
    WHERE user_id = ${userId}`);
  return had;
}
