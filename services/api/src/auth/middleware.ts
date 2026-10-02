import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie } from "hono/cookie";
import type { Actor, AppContext, AppEnv, Role } from "../context";
import type { Tx } from "../db/client";
import { sql } from "../db/sql";
import { ApiError, fail } from "../http/errors";
import { isUuid } from "../http/validation";
import { sha256Hex, timingSafeEqual } from "./crypto";
import { SESSION_COOKIE, SESSION_IDLE_SECONDS, findWebSession, revokeWebSession, type WebSessionRow } from "./session";
import { userForAccessToken } from "./tokens";

export interface MembershipRow {
  org_id: string;
  role: Role;
  active: boolean;
  org_name: string;
  timezone: string;
  display_name: string;
  require_admin_mfa: boolean;
}

/** Memberships of a verified user across organisations (authentication bootstrap only). */
export async function membershipsOf(tx: Tx, userId: string): Promise<MembershipRow[]> {
  return tx.query<MembershipRow>(sql`
    SELECT m.org_id, m.role, m.active, o.name AS org_name, o.timezone, u.display_name,
           coalesce((o.settings->>'require_admin_mfa')::boolean, true) AS require_admin_mfa
    FROM app.memberships m
    JOIN app.organizations o ON o.id = m.org_id
    JOIN app.users u ON u.id = m.id
    WHERE m.id = ${userId}
    ORDER BY o.name, m.org_id`);
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const API_PREFIX = "/api/v1";

function isMfaExempt(c: AppContext): boolean {
  const p = c.req.path;
  return p.startsWith(`${API_PREFIX}/auth/`) || (p === `${API_PREFIX}/me` && c.req.method === "GET");
}

/** Cookie-authenticated state-changing requests must come from the app origin and carry the CSRF token. */
async function enforceCsrf(c: AppContext, session: WebSessionRow): Promise<void> {
  if (!UNSAFE.has(c.req.method)) return;
  const expected = c.get("deps").config.appOrigin;
  const origin = c.req.header("Origin") ?? (() => {
    const ref = c.req.header("Referer");
    try {
      return ref ? new URL(ref).origin : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!origin || origin !== expected) fail("ORIGIN_REJECTED");
  const token = c.req.header("X-CSRF-Token");
  if (!token || !timingSafeEqual(await sha256Hex(token), session.csrf_hash)) fail("CSRF_FAILED");
}

/** iOS: opaque access token issued by POST /auth/tokens (hash lookup in app.bearer_sessions). */
async function authenticateBearer(c: AppContext, token: string): Promise<Actor> {
  const userId = await c.get("db").tx({}, (tx) => userForAccessToken(tx, token, c.get("deps").now()));
  if (!userId) fail("UNAUTHENTICATED");
  const verified = { userId, aal: "aal1" as const };
  const memberships = await c.get("db").tx({ authUserId: verified.userId }, (tx) => membershipsOf(tx, verified.userId));
  const requestedOrg = c.req.header("X-ARMS-Org");
  let m: MembershipRow | undefined;
  if (requestedOrg) {
    if (!isUuid(requestedOrg)) fail("FORBIDDEN");
    m = memberships.find((x) => x.org_id === requestedOrg.toLowerCase());
    if (!m) fail("FORBIDDEN");
  } else {
    const active = memberships.filter((x) => x.active);
    if (active.length > 1) fail("ORG_SELECTION_REQUIRED", { details: { organizations: active.map((x) => ({ id: x.org_id, name: x.org_name })) } });
    m = active[0] ?? memberships[0];
  }
  if (!m) fail("FORBIDDEN");
  if (!m.active) fail("ACCOUNT_DISABLED");
  if (m.role === "admin" && !(c.req.path === `${API_PREFIX}/me` && c.req.method === "GET")) fail("ADMIN_USE_WEB");
  return {
    userId: verified.userId,
    orgId: m.org_id,
    role: m.role,
    orgName: m.org_name,
    timezone: m.timezone,
    displayName: m.display_name,
    method: "bearer",
    sessionHash: null,
    aal: verified.aal,
  };
}

async function authenticateCookie(c: AppContext, cookie: string): Promise<{ actor: Actor; requireAdminMfa: boolean }> {
  const deps = c.get("deps");
  const db = c.get("db");
  const key = deps.config.sessionKey;
  if (!key) fail("NOT_CONFIGURED");
  const sessionHash = await sha256Hex(cookie);
  const now = deps.now();

  const expire = async (): Promise<never> => {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: c.get("deps").config.cookieSecure, httpOnly: true, sameSite: "Strict" });
    fail("SESSION_EXPIRED");
  };

  const session = await db.tx({}, (tx) => findWebSession(tx, sessionHash));
  if (!session) return expire();
  if (new Date(session.expires_at) <= now || now.getTime() - new Date(session.last_seen_at).getTime() > SESSION_IDLE_SECONDS * 1000) {
    await db.tx({}, (tx) => revokeWebSession(tx, sessionHash));
    return expire();
  }
  await enforceCsrf(c, session);

  const verified = { userId: session.user_id };
  const memberships = await db.tx({ authUserId: verified.userId }, (tx) => membershipsOf(tx, verified.userId));
  const m = memberships.find((x) => x.org_id === session.org_id);
  if (!m || !m.active) {
    await db.tx({}, (tx) => revokeWebSession(tx, sessionHash));
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: c.get("deps").config.cookieSecure, httpOnly: true, sameSite: "Strict" });
    fail("ACCOUNT_DISABLED");
  }
  if (m.role !== session.role) return expire();

  if (now.getTime() - new Date(session.last_seen_at).getTime() > 60_000) {
    await db.tx({}, (tx) => tx.exec(sql`UPDATE app.web_sessions SET last_seen_at = now() WHERE id = ${sessionHash}`));
  }
  return {
    actor: {
      userId: verified.userId,
      orgId: m.org_id,
      role: m.role,
      orgName: m.org_name,
      timezone: m.timezone,
      displayName: m.display_name,
      method: "cookie",
      sessionHash,
      aal: session.aal === "aal2" ? "aal2" : "aal1",
    },
    requireAdminMfa: m.require_admin_mfa,
  };
}

/**
 * Authenticates the request from exactly one credential: `Authorization: Bearer` (iOS) or the
 * `arms_session` cookie (Web). Supplying both is rejected. Role and organisation come from DB membership.
 */
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const authz = c.req.header("Authorization");
  const cookie = getCookie(c, SESSION_COOKIE);
  if (authz && cookie) fail("AMBIGUOUS_AUTH");
  if (authz) {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(authz);
    if (!m?.[1]) fail("UNAUTHENTICATED");
    c.set("actor", await authenticateBearer(c, m[1]));
  } else if (cookie) {
    const { actor, requireAdminMfa } = await authenticateCookie(c, cookie);
    if (actor.role === "admin" && requireAdminMfa && actor.aal !== "aal2" && !isMfaExempt(c)) fail("MFA_REQUIRED");
    c.set("actor", actor);
  } else {
    fail("UNAUTHENTICATED");
  }
  await next();
});

/** Route guard. UI hiding is not a control: every endpoint declares its allowed roles here. */
export function requireRole(...roles: Role[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!roles.includes(c.get("actor").role)) throw new ApiError("FORBIDDEN");
    await next();
  });
}
