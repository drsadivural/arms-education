import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { LoginInput, MfaVerifyInput, PasswordResetInput } from "@arms/contracts";
import type { AppContext, AppEnv } from "../context";
import { sql } from "../db/sql";
import { json } from "../db/client";
import { createMiddleware } from "hono/factory";
import { membershipsOf, type MembershipRow } from "../auth/middleware";
import { InvalidTokenError } from "../auth/jwt";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createWebSession, decryptSecrets, findWebSession, revokeWebSession, storeRefreshedTokens } from "../auth/session";
import { ApiError, fail } from "../http/errors";
import { readBody } from "../http/validation";
import { action } from "../http/respond";
import { rateLimit } from "../http/rate-limit";


const cookieOptions = (maxAge: number) => ({ path: "/", httpOnly: true, secure: true, sameSite: "Strict" as const, maxAge });

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

export const authRoutes = new Hono<AppEnv>();

/** WEB-01: password login, server-side role check, HttpOnly session. Students use the iOS app. */
authRoutes.post("/auth/login", async (c) => {
  const input = await readBody(c, LoginInput);
  await rateLimit(c, "login", `${c.req.header("CF-Connecting-IP") ?? "local"}:${input.email.toLowerCase()}`);
  if (input.selected_role === "student") {
    fail("ROLE_MISMATCH", { message_ja: "受講者の方はiOSアプリをご利用ください。" });
  }
  const deps = c.get("deps");
  if (!deps.config.sessionKey) fail("NOT_CONFIGURED");
  const db = c.get("db");

  const provider = await deps.auth.signInWithPassword(input.email, input.password);
  let verified;
  try {
    verified = await deps.jwt.verify(provider.accessToken);
  } catch (e) {
    if (e instanceof InvalidTokenError) fail("AUTH_PROVIDER_UNAVAILABLE");
    throw e;
  }
  const memberships = await db.tx({ authUserId: verified.userId }, (tx) => membershipsOf(tx, verified.userId));
  const forRole = memberships.filter((m) => m.role === input.selected_role && (!input.organization_id || m.org_id === input.organization_id));
  const activeForRole = forRole.filter((m) => m.active);
  if (activeForRole.length === 0) {
    await deps.auth.signOut(provider.accessToken);
    if (forRole.length > 0) fail("ACCOUNT_DISABLED");
    fail("ROLE_MISMATCH");
  }
  if (activeForRole.length > 1) {
    await deps.auth.signOut(provider.accessToken);
    fail("ORG_SELECTION_REQUIRED", { details: { organizations: activeForRole.map((m) => ({ id: m.org_id, name: m.org_name })) } });
  }
  const m = activeForRole[0] as MembershipRow;

  let mfaRequired = false;
  let mfaEnrolled = false;
  if (m.role === "admin" && m.require_admin_mfa && verified.aal !== "aal2") {
    mfaRequired = true;
    mfaEnrolled = (await deps.auth.listTotpFactors(provider.accessToken)).some((f) => f.status === "verified");
  }

  const created = await db.tx({ orgId: m.org_id, userId: verified.userId }, async (tx) => {
    const s = await createWebSession(tx, deps.config.sessionKey, {
      userId: verified.userId,
      orgId: m.org_id,
      role: m.role,
      aal: verified.aal,
      accessToken: provider.accessToken,
      refreshToken: provider.refreshToken,
      accessExpiresAt: provider.expiresAt,
      now: deps.now(),
    });
    await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
      VALUES (${m.org_id}, ${verified.userId}, 'auth.login', ${verified.userId}, ${json({ role: m.role, method: "web", mfa_required: mfaRequired })}::jsonb)`);
    const email = await tx.one<{ email: string }>(sql`SELECT email FROM app.users WHERE id = ${verified.userId}`);
    return { ...s, email: email.email };
  });
  setCookie(c, SESSION_COOKIE, created.sessionId, cookieOptions(SESSION_TTL_SECONDS));
  return sessionInfo(c, {
    userId: verified.userId,
    displayName: m.display_name,
    email: created.email,
    role: m.role,
    orgName: m.org_name,
    csrfToken: created.csrfToken,
    expiresAt: created.expiresAt,
    mfaRequired,
    mfaEnrolled,
  });
});

/** Anti-enumeration: always the same response unless the provider is down. */
authRoutes.post("/auth/password-reset", async (c) => {
  const input = await readBody(c, PasswordResetInput);
  await rateLimit(c, "login", `reset:${c.req.header("CF-Connecting-IP") ?? "local"}:${input.email.toLowerCase()}`);
  await c.get("deps").auth.sendPasswordReset(input.email);
  return action(c, { message_ja: "登録済みのメールアドレスの場合、再設定の案内を送信しました。" });
});

/** Session-management endpoints exist only for the Web BFF cookie session. */
const cookieOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("actor").method !== "cookie") fail("BAD_REQUEST", { message_ja: "この操作はWebセッションでのみ利用できます。" });
  await next();
});

async function loadSecrets(c: AppContext) {
  const deps = c.get("deps");
  const actor = c.get("actor");
  const row = await c.get("db").tx({}, (tx) => findWebSession(tx, actor.sessionHash as string));
  if (!row) fail("SESSION_EXPIRED");
  return { row, secrets: await decryptSecrets(deps.config.sessionKey, row.id, row.encrypted_provider_tokens) };
}

authRoutes.get("/auth/session", cookieOnly, async (c) => {
  const actor = c.get("actor");
  const { row, secrets } = await loadSecrets(c);
  const email = await c.get("db").tx({ orgId: actor.orgId, userId: actor.userId }, (tx) => tx.one<{ email: string; require_admin_mfa: boolean }>(sql`
    SELECT u.email, coalesce((o.settings->>'require_admin_mfa')::boolean, true) AS require_admin_mfa
    FROM app.users u, app.organizations o WHERE u.id = ${actor.userId} AND o.id = ${actor.orgId}`));
  const mfaRequired = actor.role === "admin" && email.require_admin_mfa && actor.aal !== "aal2";
  const mfaEnrolled = mfaRequired
    ? (await c.get("deps").auth.listTotpFactors(secrets.accessToken)).some((f) => f.status === "verified")
    : actor.aal === "aal2";
  return sessionInfo(c, {
    userId: actor.userId,
    displayName: actor.displayName,
    email: email.email,
    role: actor.role,
    orgName: actor.orgName,
    csrfToken: secrets.csrfToken,
    expiresAt: new Date(row.expires_at),
    mfaRequired,
    mfaEnrolled,
  });
});

authRoutes.post("/auth/logout", cookieOnly, async (c) => {
  const actor = c.get("actor");
  const { secrets } = await loadSecrets(c);
  await c.get("db").tx({ orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    await revokeWebSession(tx, actor.sessionHash as string);
    await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
      VALUES (${actor.orgId}, ${actor.userId}, 'auth.logout', ${actor.userId}, '{}'::jsonb)`);
  });
  await c.get("deps").auth.signOut(secrets.accessToken);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Strict" });
  return action(c);
});

authRoutes.post("/auth/mfa/enroll", cookieOnly, async (c) => {
  const actor = c.get("actor");
  if (actor.role !== "admin") fail("FORBIDDEN");
  const { secrets } = await loadSecrets(c);
  const existing = await c.get("deps").auth.listTotpFactors(secrets.accessToken);
  if (existing.some((f) => f.status === "verified")) fail("INVALID_STATE", { message_ja: "二段階認証は登録済みです。認証コードを入力してください。" });
  const enrollment = await c.get("deps").auth.enrollTotp(secrets.accessToken, `ARMS ${actor.orgName}`);
  return c.json({
    data: { factor_id: enrollment.factorId, qr_code: enrollment.qrCode, uri: enrollment.uri },
    checked_at: c.get("deps").now().toISOString(),
  });
});

authRoutes.post("/auth/mfa/verify", cookieOnly, async (c) => {
  const actor = c.get("actor");
  if (actor.role !== "admin") fail("FORBIDDEN");
  const input = await readBody(c, MfaVerifyInput);
  await rateLimit(c, "login", `mfa:${actor.userId}`);
  const deps = c.get("deps");
  const { secrets } = await loadSecrets(c);
  // A freshly enrolled factor stays "unverified" until its first successful verification.
  const factors = await deps.auth.listTotpFactors(secrets.accessToken);
  const factorId = (factors.find((f) => f.status === "verified") ?? factors[factors.length - 1])?.id;
  if (!factorId) fail("INVALID_STATE", { message_ja: "二段階認証が登録されていません。" });
  const upgraded = await deps.auth.verifyTotp(secrets.accessToken, factorId, input.code);
  const verified = await deps.jwt.verify(upgraded.accessToken).catch(() => {
    throw new ApiError("AUTH_PROVIDER_UNAVAILABLE");
  });
  if (verified.userId !== actor.userId || verified.aal !== "aal2") fail("AUTH_PROVIDER_UNAVAILABLE");
  const sessionHash = actor.sessionHash as string;
  const row = await c.get("db").tx({ orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const locked = await findWebSession(tx, sessionHash, true);
    if (!locked) fail("SESSION_EXPIRED");
    await storeRefreshedTokens(tx, deps.config.sessionKey, locked, {
      accessToken: upgraded.accessToken,
      refreshToken: upgraded.refreshToken,
      accessExpiresAt: upgraded.expiresAt,
      csrfToken: secrets.csrfToken,
    }, "aal2");
    await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
      VALUES (${actor.orgId}, ${actor.userId}, 'auth.mfa_verified', ${actor.userId}, '{}'::jsonb)`);
    return { ...locked, email: (await tx.one<{ email: string }>(sql`SELECT email FROM app.users WHERE id = ${actor.userId}`)).email };
  });
  return sessionInfo(c, {
    userId: actor.userId,
    displayName: actor.displayName,
    email: row.email,
    role: actor.role,
    orgName: actor.orgName,
    csrfToken: secrets.csrfToken,
    expiresAt: new Date(row.expires_at),
    mfaRequired: false,
    mfaEnrolled: true,
  });
});

