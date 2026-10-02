/**
 * Web BFF sessions. The browser holds only an opaque HttpOnly cookie; provider access/refresh tokens and the
 * CSRF token are AES-GCM encrypted at rest (bound to the session hash as AAD). The DB stores sha256(session id).
 */
import type { Tx } from "../db/client";
import { sql } from "../db/sql";
import type { Role } from "../context";
import { decryptString, encryptString, randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "arms_session";
/** Absolute lifetime of a web session. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
/** Idle timeout: sessions unused for this long are rejected. */
export const SESSION_IDLE_SECONDS = 2 * 60 * 60;

export interface SessionSecrets {
  accessToken: string;
  refreshToken: string;
  /** epoch seconds */
  accessExpiresAt: number;
  csrfToken: string;
}

export interface WebSessionRow {
  id: string;
  user_id: string;
  org_id: string;
  role: Role;
  aal: "aal1" | "aal2";
  encrypted_provider_tokens: string;
  csrf_hash: string;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

export async function encryptSecrets(key: string, sessionHash: string, s: SessionSecrets): Promise<string> {
  return encryptString(key, JSON.stringify({ a: s.accessToken, r: s.refreshToken, e: s.accessExpiresAt, c: s.csrfToken }), `web_session:${sessionHash}`);
}

export async function decryptSecrets(key: string, sessionHash: string, payload: string): Promise<SessionSecrets> {
  const o = JSON.parse(await decryptString(key, payload, `web_session:${sessionHash}`)) as { a: string; r: string; e: number; c: string };
  return { accessToken: o.a, refreshToken: o.r, accessExpiresAt: o.e, csrfToken: o.c };
}

export async function createWebSession(
  tx: Tx,
  key: string,
  input: { userId: string; orgId: string; role: Role; aal: "aal1" | "aal2"; accessToken: string; refreshToken: string; accessExpiresAt: number; now: Date },
): Promise<{ sessionId: string; sessionHash: string; csrfToken: string; expiresAt: Date }> {
  const sessionId = randomToken(32);
  const sessionHash = await sha256Hex(sessionId);
  const csrfToken = randomToken(32);
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_SECONDS * 1000);
  const encrypted = await encryptSecrets(key, sessionHash, {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    accessExpiresAt: input.accessExpiresAt,
    csrfToken,
  });
  await tx.exec(sql`
    INSERT INTO app.web_sessions(id, user_id, org_id, role, aal, encrypted_provider_tokens, csrf_hash, expires_at, last_seen_at)
    VALUES (${sessionHash}, ${input.userId}, ${input.orgId}, ${input.role}, ${input.aal}, ${encrypted}, ${await sha256Hex(csrfToken)}, ${expiresAt}, ${input.now})`);
  return { sessionId, sessionHash, csrfToken, expiresAt };
}

export async function findWebSession(tx: Tx, sessionHash: string, forUpdate = false): Promise<WebSessionRow | null> {
  return tx.maybeOne<WebSessionRow>(
    forUpdate
      ? sql`SELECT * FROM app.web_sessions WHERE id = ${sessionHash} AND revoked_at IS NULL FOR UPDATE`
      : sql`SELECT * FROM app.web_sessions WHERE id = ${sessionHash} AND revoked_at IS NULL`,
  );
}

export async function storeRefreshedTokens(tx: Tx, key: string, row: WebSessionRow, secrets: SessionSecrets, aal: "aal1" | "aal2"): Promise<void> {
  const encrypted = await encryptSecrets(key, row.id, secrets);
  await tx.exec(sql`UPDATE app.web_sessions SET encrypted_provider_tokens = ${encrypted}, aal = ${aal}, last_seen_at = now() WHERE id = ${row.id}`);
}

export async function revokeWebSession(tx: Tx, sessionHash: string): Promise<void> {
  await tx.exec(sql`UPDATE app.web_sessions SET revoked_at = now() WHERE id = ${sessionHash} AND revoked_at IS NULL`);
}

/** Revokes every web session of a user in an organisation (used when an account is disabled). */
export async function revokeUserSessions(tx: Tx, orgId: string, userId: string): Promise<void> {
  await tx.exec(sql`UPDATE app.web_sessions SET revoked_at = now() WHERE org_id = ${orgId} AND user_id = ${userId} AND revoked_at IS NULL`);
}
