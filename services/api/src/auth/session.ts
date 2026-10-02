/**
 * Web BFF sessions. The browser holds only an opaque HttpOnly cookie; the DB stores sha256(session id), the
 * authenticator assurance level (aal2 after administrator TOTP) and the CSRF token AES-GCM encrypted at rest
 * (bound to the session hash as AAD) so it can be handed back to the SPA after a reload.
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

export interface WebSessionRow {
  id: string;
  user_id: string;
  org_id: string;
  role: Role;
  aal: "aal1" | "aal2";
  encrypted_secrets: string;
  csrf_hash: string;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

const aad = (sessionHash: string) => `web_session:${sessionHash}`;

export async function readCsrfToken(key: string, row: WebSessionRow): Promise<string> {
  const o = JSON.parse(await decryptString(key, row.encrypted_secrets, aad(row.id))) as { c: string };
  return o.c;
}

export async function createWebSession(
  tx: Tx,
  key: string,
  input: { userId: string; orgId: string; role: Role; aal: "aal1" | "aal2"; now: Date },
): Promise<{ sessionId: string; sessionHash: string; csrfToken: string; expiresAt: Date }> {
  const sessionId = randomToken(32);
  const sessionHash = await sha256Hex(sessionId);
  const csrfToken = randomToken(32);
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_SECONDS * 1000);
  const encrypted = await encryptString(key, JSON.stringify({ c: csrfToken }), aad(sessionHash));
  await tx.exec(sql`
    INSERT INTO app.web_sessions(id, user_id, org_id, role, aal, encrypted_secrets, csrf_hash, expires_at, last_seen_at)
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

/** Raises the session to aal2 after a successful TOTP verification. */
export async function elevateWebSession(tx: Tx, sessionHash: string): Promise<void> {
  await tx.exec(sql`UPDATE app.web_sessions SET aal = 'aal2', last_seen_at = now() WHERE id = ${sessionHash} AND revoked_at IS NULL`);
}

export async function revokeWebSession(tx: Tx, sessionHash: string): Promise<void> {
  await tx.exec(sql`UPDATE app.web_sessions SET revoked_at = now() WHERE id = ${sessionHash} AND revoked_at IS NULL`);
}

/** Revokes every web session of a user in an organisation (used when an account is disabled). */
export async function revokeUserSessions(tx: Tx, orgId: string, userId: string): Promise<void> {
  await tx.exec(sql`UPDATE app.web_sessions SET revoked_at = now() WHERE org_id = ${orgId} AND user_id = ${userId} AND revoked_at IS NULL`);
}

/** Revokes every web session of a user in all organisations (password change, MFA reset). */
export async function revokeAllUserWebSessions(tx: Tx, userId: string, exceptSessionHash: string | null = null): Promise<void> {
  await tx.exec(sql`UPDATE app.web_sessions SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL AND (${exceptSessionHash}::text IS NULL OR id <> ${exceptSessionHash})`);
}
