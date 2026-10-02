/**
 * Authentication endpoints. ARMS authenticates against its own PostgreSQL tables (app.user_credentials etc.):
 * - Web (admin/teacher): POST /auth/login → HttpOnly session cookie + CSRF token; administrators then pass TOTP.
 * - iOS (student/teacher): POST /auth/tokens → opaque Bearer access token + rotating refresh token.
 * - Invitation / password reset: one-time e-mail link tokens → POST /auth/password.
 * Roles always come from DB memberships, never from the client.
 */
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { LoginInput, MfaVerifyInput, PasswordResetInput, PasswordSetInput, TokenGrantInput, TokenRefreshInput } from "@arms/contracts";
import type { AppContext, AppEnv } from "../context";
import { sql } from "../db/sql";
import { json, type Tx } from "../db/client";
import { membershipsOf, type MembershipRow } from "../auth/middleware";
import { checkLogin, setPassword, totpEnrolled, beginTotpEnrollment, verifyTotpCode } from "../auth/credentials";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createWebSession, elevateWebSession, findWebSession, readCsrfToken, revokeAllUserWebSessions, revokeWebSession } from "../auth/session";
import {
  ACCESS_TTL_SECONDS,
  consumeLinkToken,
  createLinkToken,
  issueBearerSession,
  refreshBearerSession,
  revokeBearerByRefresh,
  revokeUserBearerSessions,
  type TokenPair,
} from "../auth/tokens";
import { sendLinkEmail } from "../auth/emails";
import { otpauthUri, qrCodeDataUrl } from "../auth/totp";
import { fail } from "../http/errors";
import { readBody } from "../http/validation";
import { action } from "../http/respond";
import { rateLimit } from "../http/rate-limit";

const cookieOptions = (secure: boolean, maxAge: number) => ({ path: "/", httpOnly: true, secure, sameSite: "Strict" as const, maxAge });
const clientIp = (c: AppContext) => c.req.header("CF-Connecting-IP") ?? "local";

interface SessionInfoParams {
  userId: string;
  displayName: string;
  email: string;
  role: MembershipRow["role"];
  orgName: string;
  csrfToken: string;
  expiresAt: Date;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
}

function sessionInfo(c: AppContext, p: SessionInfoParams) {
  return c.json({
    data: {
      user: { id: p.userId, display_name: p.displayName, email: p.email, role: p.role, active: true },
      csrf_token: p.csrfToken,
      expires_at: p.expiresAt.toISOString(),
      organization_name: p.orgName,
      mfa_required: p.mfaRequired,
      mfa_enrolled: p.mfaEnrolled,
    },
    checked_at: c.get("deps").now().toISOString(),
  });
}

function tokenResponse(c: AppContext, userId: string, t: TokenPair) {
  return c.json({
    data: {
      access_token: t.accessToken,
      refresh_token: t.refreshToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_expires_at: t.sessionExpiresAt.toISOString(),
      user_id: userId,
    },
    checked_at: c.get("deps").now().toISOString(),
  });
}

async function authAudit(tx: Tx, orgId: string, userId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
  await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
    VALUES (${orgId}, ${userId}, ${eventType}, ${userId}, ${json(payload)}::jsonb)`);
}

/**
 * E-mail + password check in its own transaction. A failure is raised only after the failed-attempt counter has
 * been committed (lockout after repeated failures).
 */
async function authenticatePassword(c: AppContext, email: string, password: string): Promise<string> {
  const now = c.get("deps").now();
  const result = await c.get("db").tx({}, (tx) => checkLogin(tx, email, password, now));
  if (!result.ok) throw result.error;
  return result.userId;
}

export const authRoutes = new Hono<AppEnv>();

/** WEB-01: password login, server-side role check, HttpOnly session. Students use the iOS app. */
authRoutes.post("/auth/login", async (c) => {
  const input = await readBody(c, LoginInput);
  await rateLimit(c, "login", `${clientIp(c)}:${input.email.toLowerCase()}`);
  if (input.selected_role === "student") {
    fail("ROLE_MISMATCH", { message_ja: "受講者の方はiOSアプリをご利用ください。" });
  }
  const deps = c.get("deps");
  if (!deps.config.sessionKey) fail("NOT_CONFIGURED");
  const db = c.get("db");

  const userId = await authenticatePassword(c, input.email, input.password);
  const memberships = await db.tx({ authUserId: userId }, (tx) => membershipsOf(tx, userId));
  const forRole = memberships.filter((m) => m.role === input.selected_role && (!input.organization_id || m.org_id === input.organization_id));
  const activeForRole = forRole.filter((m) => m.active);
  if (activeForRole.length === 0) fail(forRole.length > 0 ? "ACCOUNT_DISABLED" : "ROLE_MISMATCH");
  if (activeForRole.length > 1) {
    fail("ORG_SELECTION_REQUIRED", { details: { organizations: activeForRole.map((m) => ({ id: m.org_id, name: m.org_name })) } });
  }
  const m = activeForRole[0] as MembershipRow;
  const mfaRequired = m.role === "admin" && m.require_admin_mfa;

  const created = await db.tx({ orgId: m.org_id, userId }, async (tx) => {
    const s = await createWebSession(tx, deps.config.sessionKey, { userId, orgId: m.org_id, role: m.role, aal: "aal1", now: deps.now() });
    await authAudit(tx, m.org_id, userId, "auth.login", { role: m.role, method: "web", mfa_required: mfaRequired });
    const user = await tx.one<{ email: string }>(sql`SELECT email FROM app.users WHERE id = ${userId}`);
    return { ...s, email: user.email, mfaEnrolled: mfaRequired ? await totpEnrolled(tx, userId) : false };
  });
  setCookie(c, SESSION_COOKIE, created.sessionId, cookieOptions(deps.config.cookieSecure, SESSION_TTL_SECONDS));
  return sessionInfo(c, {
    userId,
    displayName: m.display_name,
    email: created.email,
    role: m.role,
    orgName: m.org_name,
    csrfToken: created.csrfToken,
    expiresAt: created.expiresAt,
    mfaRequired,
    mfaEnrolled: created.mfaEnrolled,
  });
});

/** IOS-01: password sign-in for the iOS app → Bearer tokens. The role is checked afterwards by GET /me. */
authRoutes.post("/auth/tokens", async (c) => {
  const input = await readBody(c, TokenGrantInput);
  await rateLimit(c, "login", `${clientIp(c)}:${input.email.toLowerCase()}`);
  const deps = c.get("deps");
  const userId = await authenticatePassword(c, input.email, input.password);
  const memberships = await c.get("db").tx({ authUserId: userId }, (tx) => membershipsOf(tx, userId));
  const active = memberships.filter((m) => m.active);
  if (active.length === 0) fail(memberships.length ? "ACCOUNT_DISABLED" : "FORBIDDEN");
  const first = active[0] as MembershipRow;
  const tokens = await c.get("db").tx({ orgId: first.org_id, userId }, async (tx) => {
    const t = await issueBearerSession(tx, userId, input.device_label ?? null, deps.now());
    await authAudit(tx, first.org_id, userId, "auth.login", { role: first.role, method: "ios" });
    return t;
  });
  return tokenResponse(c, userId, tokens);
});

authRoutes.post("/auth/tokens/refresh", async (c) => {
  const input = await readBody(c, TokenRefreshInput);
  await rateLimit(c, "login", `refresh:${clientIp(c)}`);
  const deps = c.get("deps");
  const result = await c.get("db").tx({}, (tx) => refreshBearerSession(tx, input.refresh_token, deps.now()));
  if (!result.ok) {
    if (result.reason === "reused") deps.log({ level: "warn", msg: "refresh_token_reuse", request_id: c.get("requestId") });
    fail("SESSION_EXPIRED");
  }
  // A disabled account cannot keep refreshing (its requests would be refused by the membership check anyway).
  const memberships = await c.get("db").tx({ authUserId: result.userId }, (tx) => membershipsOf(tx, result.userId));
  if (!memberships.some((m) => m.active)) {
    await c.get("db").tx({}, (tx) => revokeUserBearerSessions(tx, result.userId, "account_disabled", deps.now()));
    fail("ACCOUNT_DISABLED");
  }
  return tokenResponse(c, result.userId, result.tokens);
});

authRoutes.post("/auth/tokens/revoke", async (c) => {
  const input = await readBody(c, TokenRefreshInput);
  await rateLimit(c, "login", `revoke:${clientIp(c)}`);
  const deps = c.get("deps");
  const userId = await c.get("db").tx({}, (tx) => revokeBearerByRefresh(tx, input.refresh_token, deps.now()));
  if (userId) {
    const first = (await c.get("db").tx({ authUserId: userId }, (tx) => membershipsOf(tx, userId)))[0];
    if (first) await c.get("db").tx({ orgId: first.org_id, userId }, (tx) => authAudit(tx, first.org_id, userId, "auth.logout", { method: "ios" }));
  }
  return action(c);
});

/**
 * Sends a one-hour reset link to registered users with an active membership. Anti-enumeration: unknown, disabled and
 * known addresses get the same answer; only a missing or failing mail service is reported (503).
 */
authRoutes.post("/auth/password-reset", async (c) => {
  const input = await readBody(c, PasswordResetInput);
  await rateLimit(c, "login", `reset:${clientIp(c)}:${input.email.toLowerCase()}`);
  const deps = c.get("deps");
  if (!deps.integrations.mail) fail("NOT_CONFIGURED", { message_ja: "メール送信サービスが未設定のため、再設定メールを送信できません。管理者にお問い合わせください。" });
  const db = c.get("db");
  const user = await db.tx({}, (tx) =>
    tx.maybeOne<{ id: string; email: string; display_name: string }>(sql`SELECT id, email, display_name FROM app.users WHERE lower(email) = lower(${input.email})`),
  );
  const active = user ? (await db.tx({ authUserId: user.id }, (tx) => membershipsOf(tx, user.id))).filter((m) => m.active) : [];
  if (user && active.length > 0) {
    const org = active[0] as MembershipRow;
    const link = await db.tx({ orgId: org.org_id, userId: user.id }, async (tx) => {
      const l = await createLinkToken(tx, user.id, "password_reset", deps.now());
      await authAudit(tx, org.org_id, user.id, "auth.password_reset_requested");
      return l;
    });
    await sendLinkEmail(deps, {
      to: user.email,
      displayName: user.display_name,
      orgName: org.org_name,
      token: link.token,
      tokenId: link.id,
      purpose: "password_reset",
      expiresAt: link.expiresAt,
    });
  }
  return action(c, { message_ja: "登録済みのメールアドレスの場合、再設定の案内を送信しました。" });
});

/**
 * Sets the password from an invitation or password-reset e-mail link (one-time token). The account must have an
 * active organisation membership. A reset signs the user out everywhere. Students are told to sign in from the iOS
 * app, staff from the Web login.
 */
authRoutes.post("/auth/password", async (c) => {
  const input = await readBody(c, PasswordSetInput);
  await rateLimit(c, "login", `password:${clientIp(c)}`);
  const deps = c.get("deps");
  const now = deps.now();
  const result = await c.get("db").tx({}, async (tx) => {
    const link = await consumeLinkToken(tx, input.token, now);
    if (!link) fail("SESSION_EXPIRED", { message_ja: "リンクの有効期限が切れているか、既に使用されています。もう一度メールのリンクを発行してください。" });
    await tx.exec(sql`SELECT set_config('app.auth_user_id', ${link.userId}, true)`);
    const memberships = await membershipsOf(tx, link.userId);
    const active = memberships.filter((m) => m.active);
    // Raised inside the transaction so the link stays usable when the account is (temporarily) disabled.
    if (active.length === 0) fail(memberships.length ? "ACCOUNT_DISABLED" : "FORBIDDEN");
    await setPassword(tx, link.userId, input.password, now);
    if (link.purpose === "password_reset") {
      await revokeAllUserWebSessions(tx, link.userId);
      await revokeUserBearerSessions(tx, link.userId, "password_reset", now);
    }
    return { userId: link.userId, purpose: link.purpose, active };
  });
  const first = result.active[0] as MembershipRow;
  await c.get("db").tx({ orgId: first.org_id, userId: result.userId }, (tx) =>
    authAudit(tx, first.org_id, result.userId, "auth.password_set", { via: result.purpose }),
  );
  const roles = [...new Set(result.active.map((m) => m.role))];
  return action(c, {
    roles,
    sign_in: roles.some((r) => r !== "student") ? "web" : "ios",
    message_ja: roles.some((r) => r !== "student")
      ? "パスワードを設定しました。ログイン画面からログインしてください。"
      : "パスワードを設定しました。iOSアプリからログインしてください。",
  });
});

/** Session-management endpoints exist only for the Web BFF cookie session. */
const cookieOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("actor").method !== "cookie") fail("BAD_REQUEST", { message_ja: "この操作はWebセッションでのみ利用できます。" });
  await next();
});

async function currentSession(c: AppContext) {
  const row = await c.get("db").tx({}, (tx) => findWebSession(tx, c.get("actor").sessionHash as string));
  if (!row) fail("SESSION_EXPIRED");
  return { row, csrfToken: await readCsrfToken(c.get("deps").config.sessionKey, row) };
}

authRoutes.get("/auth/session", cookieOnly, async (c) => {
  const actor = c.get("actor");
  const { row, csrfToken } = await currentSession(c);
  const info = await c.get("db").tx({ orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const r = await tx.one<{ email: string; require_admin_mfa: boolean }>(sql`
      SELECT u.email, coalesce((o.settings->>'require_admin_mfa')::boolean, true) AS require_admin_mfa
      FROM app.users u, app.organizations o WHERE u.id = ${actor.userId} AND o.id = ${actor.orgId}`);
    return { ...r, enrolled: await totpEnrolled(tx, actor.userId) };
  });
  const mfaRequired = actor.role === "admin" && info.require_admin_mfa && actor.aal !== "aal2";
  return sessionInfo(c, {
    userId: actor.userId,
    displayName: actor.displayName,
    email: info.email,
    role: actor.role,
    orgName: actor.orgName,
    csrfToken,
    expiresAt: new Date(row.expires_at),
    mfaRequired,
    mfaEnrolled: mfaRequired ? info.enrolled : actor.aal === "aal2",
  });
});

authRoutes.post("/auth/logout", cookieOnly, async (c) => {
  const actor = c.get("actor");
  await c.get("db").tx({ orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    await revokeWebSession(tx, actor.sessionHash as string);
    await authAudit(tx, actor.orgId, actor.userId, "auth.logout", { method: "web" });
  });
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: c.get("deps").config.cookieSecure, httpOnly: true, sameSite: "Strict" });
  return action(c);
});

/** Starts TOTP enrollment: a new secret as QR code + otpauth URI (confirmed by the first successful verification). */
authRoutes.post("/auth/mfa/enroll", cookieOnly, async (c) => {
  const actor = c.get("actor");
  if (actor.role !== "admin") fail("FORBIDDEN");
  const deps = c.get("deps");
  const { secret, email } = await c.get("db").tx({ orgId: actor.orgId, userId: actor.userId }, async (tx) => ({
    secret: await beginTotpEnrollment(tx, deps.config.sessionKey, actor.userId, deps.now()),
    email: (await tx.one<{ email: string }>(sql`SELECT email FROM app.users WHERE id = ${actor.userId}`)).email,
  }));
  const uri = otpauthUri(secret, `${email} (${actor.orgName})`);
  return c.json({ data: { factor_id: actor.userId, qr_code: qrCodeDataUrl(uri), uri }, checked_at: deps.now().toISOString() });
});

authRoutes.post("/auth/mfa/verify", cookieOnly, async (c) => {
  const actor = c.get("actor");
  if (actor.role !== "admin") fail("FORBIDDEN");
  const input = await readBody(c, MfaVerifyInput);
  await rateLimit(c, "login", `mfa:${actor.userId}`);
  const deps = c.get("deps");
  const sessionHash = actor.sessionHash as string;
  const row = await c.get("db").tx({ orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const locked = await findWebSession(tx, sessionHash, true);
    if (!locked) fail("SESSION_EXPIRED");
    const { enrolledNow } = await verifyTotpCode(tx, deps.config.sessionKey, actor.userId, input.code, deps.now());
    await elevateWebSession(tx, sessionHash);
    if (enrolledNow) await authAudit(tx, actor.orgId, actor.userId, "auth.mfa_enrolled");
    await authAudit(tx, actor.orgId, actor.userId, "auth.mfa_verified");
    return { ...locked, email: (await tx.one<{ email: string }>(sql`SELECT email FROM app.users WHERE id = ${actor.userId}`)).email };
  });
  return sessionInfo(c, {
    userId: actor.userId,
    displayName: actor.displayName,
    email: row.email,
    role: actor.role,
    orgName: actor.orgName,
    csrfToken: await readCsrfToken(deps.config.sessionKey, row),
    expiresAt: new Date(row.expires_at),
    mfaRequired: false,
    mfaEnrolled: true,
  });
});
