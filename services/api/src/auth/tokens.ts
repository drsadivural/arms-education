/**
 * Opaque tokens issued by the API (no identity provider):
 * - iOS bearer sessions: access token (1 h) + refresh token rotated on every refresh. The session ends 90 days after
 *   sign-in or after 30 days without a refresh. Presenting a refresh token that was already rotated away revokes the
 *   session (RFC 9700 §4.14.2 refresh token reuse detection).
 * - E-mail link tokens: invitation (24 h) and password reset (1 h), single use.
 * Tokens are 256-bit random values with a readable prefix (so leaked tokens are recognisable by secret scanners);
 * the DB stores only their SHA-256.
 */
import type { Tx } from "../db/client";
import { sql } from "../db/sql";
import { randomToken, sha256Hex } from "./crypto";

export const ACCESS_TTL_SECONDS = 60 * 60;
export const BEARER_SESSION_MAX_SECONDS = 90 * 24 * 60 * 60;
export const BEARER_SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;
export const LINK_TTL_SECONDS = { invite: 24 * 60 * 60, password_reset: 60 * 60 } as const;
export type LinkPurpose = keyof typeof LINK_TTL_SECONDS;

const ACCESS_PREFIX = "arms_at_";
const REFRESH_PREFIX = "arms_rt_";
const LINK_PREFIX = "arms_lt_";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  sessionExpiresAt: Date;
}

function pair(now: Date, sessionExpiresAt: Date) {
  return {
    accessToken: ACCESS_PREFIX + randomToken(32),
    refreshToken: REFRESH_PREFIX + randomToken(32),
    accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_SECONDS * 1000),
    sessionExpiresAt,
  };
}

export async function issueBearerSession(tx: Tx, userId: string, deviceLabel: string | null, now: Date): Promise<TokenPair> {
  const tokens = pair(now, new Date(now.getTime() + BEARER_SESSION_MAX_SECONDS * 1000));
  await tx.exec(sql`
    INSERT INTO app.bearer_sessions(user_id, access_hash, access_expires_at, refresh_hash, expires_at, device_label, created_at, last_used_at)
    VALUES (${userId}, ${await sha256Hex(tokens.accessToken)}, ${tokens.accessExpiresAt}, ${await sha256Hex(tokens.refreshToken)},
      ${tokens.sessionExpiresAt}, ${deviceLabel}, ${now}, ${now})`);
  return tokens;
}

interface BearerRow {
  id: string;
  user_id: string;
  expires_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
}

export type RefreshOutcome = { ok: true; userId: string; tokens: TokenPair } | { ok: false; reason: "unknown" | "expired" | "reused" };

/** Rotates the refresh token. The row lock serialises concurrent refreshes of one session. */
export async function refreshBearerSession(tx: Tx, refreshToken: string, now: Date): Promise<RefreshOutcome> {
  if (!refreshToken.startsWith(REFRESH_PREFIX)) return { ok: false, reason: "unknown" };
  const hash = await sha256Hex(refreshToken);
  const row = await tx.maybeOne<BearerRow>(sql`
    SELECT id, user_id, expires_at, last_used_at, revoked_at FROM app.bearer_sessions WHERE refresh_hash = ${hash} FOR UPDATE`);
  if (!row) {
    const reused = await tx.maybeOne<{ id: string }>(sql`
      UPDATE app.bearer_sessions SET revoked_at = ${now}, revoked_reason = 'refresh_reuse'
      WHERE previous_refresh_hash = ${hash} AND revoked_at IS NULL RETURNING id`);
    return { ok: false, reason: reused ? "reused" : "unknown" };
  }
  if (row.revoked_at) return { ok: false, reason: "unknown" };
  const idleLimit = new Date(row.last_used_at).getTime() + BEARER_SESSION_IDLE_SECONDS * 1000;
  if (new Date(row.expires_at) <= now || idleLimit <= now.getTime()) {
    await tx.exec(sql`UPDATE app.bearer_sessions SET revoked_at = ${now}, revoked_reason = 'expired' WHERE id = ${row.id}`);
    return { ok: false, reason: "expired" };
  }
  const tokens = pair(now, new Date(row.expires_at));
  await tx.exec(sql`
    UPDATE app.bearer_sessions SET access_hash = ${await sha256Hex(tokens.accessToken)}, access_expires_at = ${tokens.accessExpiresAt},
      previous_refresh_hash = refresh_hash, refresh_hash = ${await sha256Hex(tokens.refreshToken)}, last_used_at = ${now}
    WHERE id = ${row.id}`);
  return { ok: true, userId: row.user_id, tokens };
}

/** Ends the session that owns the refresh token (sign-out). Unknown or already revoked tokens are ignored. */
export async function revokeBearerByRefresh(tx: Tx, refreshToken: string, now: Date): Promise<string | null> {
  if (!refreshToken.startsWith(REFRESH_PREFIX)) return null;
  const row = await tx.maybeOne<{ user_id: string }>(sql`
    UPDATE app.bearer_sessions SET revoked_at = ${now}, revoked_reason = 'sign_out'
    WHERE refresh_hash = ${await sha256Hex(refreshToken)} AND revoked_at IS NULL RETURNING user_id`);
  return row?.user_id ?? null;
}

/** The user of a valid (unexpired, unrevoked) access token, or null. */
export async function userForAccessToken(tx: Tx, accessToken: string, now: Date): Promise<string | null> {
  if (!accessToken.startsWith(ACCESS_PREFIX)) return null;
  const row = await tx.maybeOne<{ user_id: string }>(sql`
    SELECT user_id FROM app.bearer_sessions
    WHERE access_hash = ${await sha256Hex(accessToken)} AND revoked_at IS NULL AND access_expires_at > ${now} AND expires_at > ${now}`);
  return row?.user_id ?? null;
}

/** Ends every bearer session of the user (password change, account disabled everywhere, MFA reset). */
export async function revokeUserBearerSessions(tx: Tx, userId: string, reason: string, now: Date): Promise<void> {
  await tx.exec(sql`UPDATE app.bearer_sessions SET revoked_at = ${now}, revoked_reason = ${reason} WHERE user_id = ${userId} AND revoked_at IS NULL`);
}

/** Creates a single-use link token and invalidates the user's earlier unused links of the same purpose. */
export async function createLinkToken(tx: Tx, userId: string, purpose: LinkPurpose, now: Date): Promise<{ token: string; id: string; expiresAt: Date }> {
  await tx.exec(sql`UPDATE app.auth_link_tokens SET used_at = ${now} WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL`);
  const token = LINK_PREFIX + randomToken(32);
  const expiresAt = new Date(now.getTime() + LINK_TTL_SECONDS[purpose] * 1000);
  const row = await tx.one<{ id: string }>(sql`
    INSERT INTO app.auth_link_tokens(user_id, purpose, token_hash, expires_at, created_at)
    VALUES (${userId}, ${purpose}, ${await sha256Hex(token)}, ${expiresAt}, ${now}) RETURNING id`);
  return { token, id: row.id, expiresAt };
}

/** Consumes a link token (row-locked). Null when unknown, used or expired. Other open links of the user end too. */
export async function consumeLinkToken(tx: Tx, token: string, now: Date): Promise<{ userId: string; purpose: LinkPurpose } | null> {
  if (!token.startsWith(LINK_PREFIX)) return null;
  const row = await tx.maybeOne<{ id: string; user_id: string; purpose: LinkPurpose; expires_at: Date; used_at: Date | null }>(sql`
    SELECT id, user_id, purpose, expires_at, used_at FROM app.auth_link_tokens WHERE token_hash = ${await sha256Hex(token)} FOR UPDATE`);
  if (!row || row.used_at || new Date(row.expires_at) <= now) return null;
  await tx.exec(sql`UPDATE app.auth_link_tokens SET used_at = ${now} WHERE user_id = ${row.user_id} AND used_at IS NULL`);
  return { userId: row.user_id, purpose: row.purpose };
}
