import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ORIGIN, bearerCaller, call, cookieCaller, createTestContext, type TestContext } from "./helpers/app";
import { totpFromUri } from "./helpers/auth";
import { createUser, seedOrg, type OrgScenario } from "./helpers/fixtures";
import { expectContract } from "./helpers/contract";

let ctx: TestContext;
let org: OrgScenario;

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  await ctx.auth.register(org.admin.email, "admin-pass-1", org.admin.userId);
  await ctx.auth.register(org.teacher.email, "teacher-pass-1", org.teacher.userId);
  await ctx.auth.register(org.student.email, "student-pass-1", org.student.userId);
});
afterAll(async () => ctx.close());

function cookieFrom(res: { headers: Headers }): string {
  const set = res.headers.get("set-cookie") ?? "";
  const m = /arms_session=([^;]+)/.exec(set);
  if (!m) throw new Error(`no session cookie in ${set}`);
  return m[1] as string;
}

describe("health", () => {
  it("is public and checks the database", async () => {
    const res = await call(ctx, null, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.data.database).toBe("ok");
    expectContract(res, "get", "/health");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("web login (BFF)", () => {
  it("rejects wrong passwords with a Japanese message", async () => {
    const res = await call(ctx, null, "POST", "/auth/login", { body: { email: org.admin.email, password: "nope", selected_role: "admin" } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_CREDENTIALS");
    expect(res.body.message_ja).toContain("パスワード");
    expectContract(res, "post", "/auth/login");
  });

  it("rejects a selected role that does not match the DB membership", async () => {
    const res = await call(ctx, null, "POST", "/auth/login", { body: { email: org.teacher.email, password: "teacher-pass-1", selected_role: "admin" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_MISMATCH");
    expect(res.body.message_ja).toBe("このアカウントでは選択した利用区分にログインできません。");
  });

  it("directs students to the iOS app", async () => {
    const res = await call(ctx, null, "POST", "/auth/login", { body: { email: org.student.email, password: "student-pass-1", selected_role: "student" } });
    expect(res.status).toBe(403);
    expect(res.body.message_ja).toContain("iOSアプリ");
  });

  it("validates the body with Japanese field errors", async () => {
    const res = await call(ctx, null, "POST", "/auth/login", { body: { email: "not-an-email", password: "", selected_role: "boss" } });
    expect(res.status).toBe(422);
    expect(res.body.field_errors.email).toContain("メールアドレス");
    expect(res.body.field_errors.selected_role).toBeTruthy();
  });

  it("teacher login issues an HttpOnly Secure SameSite=Strict cookie and a CSRF token", async () => {
    const res = await call(ctx, null, "POST", "/auth/login", { body: { email: org.teacher.email, password: "teacher-pass-1", selected_role: "teacher" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/auth/login");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(res.body.data.user.role).toBe("teacher");
    expect(res.body.data.mfa_required).toBe(false);
    const cookie = cookieFrom(res);
    // The cookie value is never stored in the DB (only its SHA-256), and the CSRF token is encrypted at rest.
    const { rows } = await ctx.admin.query("SELECT id, encrypted_secrets FROM app.web_sessions WHERE user_id = $1", [org.teacher.userId]);
    expect(rows.some((r) => r.id === cookie)).toBe(false);
    // Stored secrets are AES-GCM ciphertext ("v1.<iv>.<ct>"), never the CSRF token itself.
    expect(rows.every((r) => /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(r.encrypted_secrets)))).toBe(true);
    expect(rows.every((r) => !String(r.encrypted_secrets).includes(res.body.data.csrf_token))).toBe(true);

    const session = await call(ctx, null, "GET", "/auth/session", { headers: { Cookie: `arms_session=${cookie}` } });
    expect(session.status).toBe(200);
    expect(session.body.data.csrf_token).toBe(res.body.data.csrf_token);
    expectContract(session, "get", "/auth/session");
  });

  it("admin login requires MFA before business APIs, then upgrades the session to aal2", async () => {
    const login = await call(ctx, null, "POST", "/auth/login", { body: { email: org.admin.email, password: "admin-pass-1", selected_role: "admin" } });
    expect(login.status).toBe(200);
    expect(login.body.data.mfa_required).toBe(true);
    expect(login.body.data.mfa_enrolled).toBe(false);
    const cookie = cookieFrom(login);
    const csrf = login.body.data.csrf_token as string;
    const h = { Cookie: `arms_session=${cookie}`, "X-CSRF-Token": csrf, Origin: TEST_ORIGIN };

    const blocked = await call(ctx, null, "PATCH", "/me/preferences", { headers: h, ifMatch: 0, body: { theme: "dark", notifications_enabled: true } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("MFA_REQUIRED");

    const me = await call(ctx, null, "GET", "/me", { headers: { Cookie: `arms_session=${cookie}` } });
    expect(me.status).toBe(200);
    expect(me.body.data.mfa).toEqual({ required: true, verified: false });

    const enroll = await call(ctx, null, "POST", "/auth/mfa/enroll", { headers: h });
    expect(enroll.status).toBe(200);
    expectContract(enroll, "post", "/auth/mfa/enroll");
    expect(enroll.body.data.qr_code).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(atob(enroll.body.data.qr_code.split(",")[1])).toContain("<svg");
    const uri = new URL(enroll.body.data.uri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("issuer")).toBe("ARMS");
    expect(uri.searchParams.get("secret")).toMatch(/^[A-Z2-7]{32}$/);
    // The secret is stored encrypted, never in plain text.
    const stored = await ctx.admin.query("SELECT totp_pending_secret_enc FROM app.user_credentials WHERE user_id = $1", [org.admin.userId]);
    expect(String(stored.rows[0].totp_pending_secret_enc)).not.toContain(uri.searchParams.get("secret"));

    const wrong = await call(ctx, null, "POST", "/auth/mfa/verify", { headers: h, body: { code: "000000" } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.field_errors.code).toBe("認証コードが正しくありません。");

    const code = await totpFromUri(enroll.body.data.uri);
    const verify = await call(ctx, null, "POST", "/auth/mfa/verify", { headers: h, body: { code } });
    expect(verify.status).toBe(200);
    expect(verify.body.data.mfa_required).toBe(false);
    expectContract(verify, "post", "/auth/mfa/verify");

    const allowed = await call(ctx, null, "PATCH", "/me/preferences", { headers: h, ifMatch: 0, body: { theme: "dark", notifications_enabled: true } });
    expect(allowed.status).toBe(200);

    // Next sign-in: the factor is enrolled, a second enrollment is refused and a used code cannot be replayed.
    const next = await call(ctx, null, "POST", "/auth/login", { body: { email: org.admin.email, password: "admin-pass-1", selected_role: "admin" } });
    expect(next.body.data).toMatchObject({ mfa_required: true, mfa_enrolled: true });
    const h2 = { Cookie: `arms_session=${cookieFrom(next)}`, "X-CSRF-Token": next.body.data.csrf_token, Origin: TEST_ORIGIN };
    expect((await call(ctx, null, "POST", "/auth/mfa/enroll", { headers: h2 })).status).toBe(409);
    const replay = await call(ctx, null, "POST", "/auth/mfa/verify", { headers: h2, body: { code } });
    expect(replay.status).toBe(422);
    const later = await totpFromUri(enroll.body.data.uri, Date.now() + 30_000);
    ctx.clock.now = new Date(Date.now() + 30_000);
    try {
      expect((await call(ctx, null, "POST", "/auth/mfa/verify", { headers: h2, body: { code: later } })).status).toBe(200);
    } finally {
      ctx.clock.now = null;
    }
    // Events written in one transaction share created_at (transaction time): break ties by name.
    const events = await ctx.admin.query(
      "SELECT event_type FROM app.audit_events WHERE actor_id = $1 AND event_type LIKE 'auth.mfa%' ORDER BY created_at, event_type",
      [org.admin.userId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["auth.mfa_enrolled", "auth.mfa_verified", "auth.mfa_verified"]);
  });

  it("locks the account for 15 minutes after 10 consecutive wrong passwords (same answer for unknown addresses)", async () => {
    const u = await createUser(ctx.admin, org.orgId, "teacher");
    await ctx.auth.register(u.email, "Right-pass-2026", u.userId);
    for (let i = 0; i < 9; i++) {
      const res = await call(ctx, null, "POST", "/auth/login", { body: { email: u.email, password: `wrong-${i}`, selected_role: "teacher" } });
      expect(res.body.code).toBe("INVALID_CREDENTIALS");
    }
    const tenth = await call(ctx, null, "POST", "/auth/login", { body: { email: u.email, password: "wrong-9", selected_role: "teacher" } });
    expect(tenth.status).toBe(429);
    expect(tenth.body.message_ja).toContain("一時的にログインを制限");
    const locked = await call(ctx, null, "POST", "/auth/tokens", { body: { email: u.email, password: "Right-pass-2026" } });
    expect(locked.status).toBe(429);
    ctx.clock.now = new Date(Date.now() + 16 * 60 * 1000);
    try {
      expect((await call(ctx, null, "POST", "/auth/login", { body: { email: u.email, password: "Right-pass-2026", selected_role: "teacher" } })).status).toBe(200);
    } finally {
      ctx.clock.now = null;
    }
    const unknown = await call(ctx, null, "POST", "/auth/login", { body: { email: "nobody@example.invalid", password: "x", selected_role: "teacher" } });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe("INVALID_CREDENTIALS");
    // An invited account without a password cannot sign in either.
    const invited = await createUser(ctx.admin, org.orgId, "teacher");
    expect((await call(ctx, null, "POST", "/auth/login", { body: { email: invited.email, password: "x", selected_role: "teacher" } })).body.code).toBe("INVALID_CREDENTIALS");
  });

  it("logout revokes the session", async () => {
    const login = await call(ctx, null, "POST", "/auth/login", { body: { email: org.teacher.email, password: "teacher-pass-1", selected_role: "teacher" } });
    const cookie = cookieFrom(login);
    const h = { Cookie: `arms_session=${cookie}`, "X-CSRF-Token": login.body.data.csrf_token, Origin: TEST_ORIGIN };
    const out = await call(ctx, null, "POST", "/auth/logout", { headers: h });
    expect(out.status).toBe(200);
    const after = await call(ctx, null, "GET", "/me", { headers: { Cookie: `arms_session=${cookie}` } });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("SESSION_EXPIRED");
  });

});

describe("cookie session protections", () => {
  it("requires the CSRF token and the app Origin on state-changing requests", async () => {
    const t = await cookieCaller(ctx, { userId: org.teacher.userId, orgId: org.orgId, role: "teacher" });
    const base = { Cookie: `arms_session=${t.sessionId}` };
    const noCsrf = await call(ctx, null, "PATCH", "/me/preferences", { headers: { ...base, Origin: TEST_ORIGIN }, ifMatch: 0, body: { theme: "light", notifications_enabled: false } });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe("CSRF_FAILED");
    const badOrigin = await call(ctx, null, "PATCH", "/me/preferences", {
      headers: { ...base, Origin: "https://evil.example", "X-CSRF-Token": t.csrfToken },
      ifMatch: 0,
      body: { theme: "light", notifications_enabled: false },
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.code).toBe("ORIGIN_REJECTED");
    const good = await call(ctx, t, "PATCH", "/me/preferences", { ifMatch: 0, body: { theme: "light", notifications_enabled: false } });
    expect(good.status).toBe(200);
    const stale = await call(ctx, t, "PATCH", "/me/preferences", { ifMatch: 0, body: { theme: "dark", notifications_enabled: false } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
  });

  it("rejects requests that carry both a cookie and a bearer token", async () => {
    const t = await cookieCaller(ctx, { userId: org.teacher.userId, orgId: org.orgId, role: "teacher" });
    const { accessToken } = await bearerCaller(org.teacher.userId, org.orgId);
    const res = await call(ctx, null, "GET", "/me", { headers: { Cookie: `arms_session=${t.sessionId}`, Authorization: `Bearer ${accessToken}` } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("AMBIGUOUS_AUTH");
  });

  it("expires idle sessions", async () => {
    const t = await cookieCaller(ctx, { userId: org.teacher.userId, orgId: org.orgId, role: "teacher" });
    ctx.clock.now = new Date(Date.now() + 3 * 60 * 60 * 1000);
    try {
      const res = await call(ctx, t, "GET", "/me");
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("SESSION_EXPIRED");
    } finally {
      ctx.clock.now = null;
    }
  });
});

describe("bearer (iOS) authentication", () => {
  it("returns /me with student classroom details and server-derived role", async () => {
    const s = await bearerCaller(org.student.userId, org.orgId);
    const res = await call(ctx, s, "GET", "/me", { headers: { "X-ARMS-Selected-Role": "student" } });
    expect(res.status).toBe(200);
    expectContract(res, "get", "/me");
    expect(res.body.data.role).toBe("student");
    expect(res.body.data.student.teacher_name).toBe("田中 祥司");
  });

  it("rejects a selected role that differs from membership", async () => {
    const s = await bearerCaller(org.student.userId, org.orgId);
    const res = await call(ctx, s, "GET", "/me", { headers: { "X-ARMS-Selected-Role": "teacher" } });
    expect(res.status).toBe(403);
    expect(res.body.message_ja).toBe("このアカウントでは選択した利用区分にログインできません。");
  });

  it("rejects unknown, refresh-instead-of-access, expired and revoked tokens", async () => {
    const s = await bearerCaller(org.student.userId, org.orgId);
    const revoked = await bearerCaller(org.student.userId, org.orgId);
    await call(ctx, null, "POST", "/auth/tokens/revoke", { body: { refresh_token: revoked.refreshToken } });
    for (const token of ["arms_at_" + "A".repeat(43), s.refreshToken, revoked.accessToken, "not.a.jwt"]) {
      const res = await call(ctx, null, "GET", "/me", { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
    }
    const issued = (await call(ctx, null, "POST", "/auth/tokens", { body: { email: org.student.email, password: "student-pass-1" } })).body.data;
    const auth = { Authorization: `Bearer ${issued.access_token}` };
    ctx.clock.now = new Date(Date.now() + 61 * 60 * 1000);
    try {
      expect((await call(ctx, null, "GET", "/me", { headers: auth })).status).toBe(401);
    } finally {
      ctx.clock.now = null;
    }
    expect((await call(ctx, null, "GET", "/me", { headers: auth })).status).toBe(200);
  });

  it("rejects disabled users even with a valid unexpired access token", async () => {
    const disabled = await createUser(ctx.admin, org.orgId, "student", { active: false });
    const s = await bearerCaller(disabled.userId, org.orgId);
    const res = await call(ctx, s, "GET", "/me");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_DISABLED");
  });

  it("rejects users without membership and spoofed organisation headers", async () => {
    const loneId = crypto.randomUUID();
    await ctx.admin.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, '所属なし', $2)", [loneId, `lone-${loneId}@example.invalid`]);
    const stranger = await bearerCaller(loneId, org.orgId);
    expect((await call(ctx, stranger, "GET", "/me")).status).toBe(403);
    const other = await seedOrg(ctx.admin);
    const s = await bearerCaller(org.student.userId, org.orgId);
    const spoof = await call(ctx, s, "GET", "/me", { headers: { "X-ARMS-Org": other.orgId } });
    expect(spoof.status).toBe(403);
  });

  it("keeps administrators on the Web (MFA-protected) channel", async () => {
    const a = await bearerCaller(org.admin.userId, org.orgId);
    expect((await call(ctx, a, "GET", "/me")).status).toBe(200);
    const res = await call(ctx, a, "PATCH", "/me/preferences", { ifMatch: 0, body: { theme: "dark", notifications_enabled: true } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ADMIN_USE_WEB");
  });

  it("requires authentication by default", async () => {
    const res = await call(ctx, null, "GET", "/me");
    expect(res.status).toBe(401);
    expectContract(res, "get", "/me");
  });
});

describe("iOS tokens (POST /auth/tokens, /refresh, /revoke)", () => {
  it("issues opaque tokens (hashes only in the DB) that authenticate /me with the server-derived role", async () => {
    const res = await call(ctx, null, "POST", "/auth/tokens", { body: { email: org.student.email, password: "student-pass-1", device_label: "iPhone 15" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/auth/tokens");
    expect(res.body.data).toMatchObject({ token_type: "Bearer", expires_in: 3600, user_id: org.student.userId });
    expect(res.body.data.access_token).toMatch(/^arms_at_[A-Za-z0-9_-]{43}$/);
    expect(res.body.data.refresh_token).toMatch(/^arms_rt_[A-Za-z0-9_-]{43}$/);
    const stored = await ctx.admin.query("SELECT access_hash, refresh_hash, device_label FROM app.bearer_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [org.student.userId]);
    expect(stored.rows[0].device_label).toBe("iPhone 15");
    expect(JSON.stringify(stored.rows[0])).not.toContain(res.body.data.access_token);
    const me = await call(ctx, null, "GET", "/me", { headers: { Authorization: `Bearer ${res.body.data.access_token}`, "X-ARMS-Selected-Role": "student" } });
    expect(me.status).toBe(200);
    expect(me.body.data.role).toBe("student");
    const wrong = await call(ctx, null, "POST", "/auth/tokens", { body: { email: org.student.email, password: "nope" } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("INVALID_CREDENTIALS");
    expectContract(wrong, "post", "/auth/tokens");
  });

  it("rotates the refresh token; presenting a rotated-away token again ends the session (theft detection)", async () => {
    const first = (await call(ctx, null, "POST", "/auth/tokens", { body: { email: org.teacher.email, password: "teacher-pass-1" } })).body.data;
    const second = await call(ctx, null, "POST", "/auth/tokens/refresh", { body: { refresh_token: first.refresh_token } });
    expect(second.status).toBe(200);
    expectContract(second, "post", "/auth/tokens/refresh");
    expect(second.body.data.refresh_token).not.toBe(first.refresh_token);
    expect(second.body.data.refresh_expires_at).toBe(first.refresh_expires_at);
    // The old access token stops working once rotated; the new one works.
    expect((await call(ctx, null, "GET", "/me", { headers: { Authorization: `Bearer ${first.access_token}` } })).status).toBe(401);
    expect((await call(ctx, null, "GET", "/me", { headers: { Authorization: `Bearer ${second.body.data.access_token}` } })).status).toBe(200);
    const reuse = await call(ctx, null, "POST", "/auth/tokens/refresh", { body: { refresh_token: first.refresh_token } });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe("SESSION_EXPIRED");
    expect((await call(ctx, null, "GET", "/me", { headers: { Authorization: `Bearer ${second.body.data.access_token}` } })).status).toBe(401);
    expect((await call(ctx, null, "POST", "/auth/tokens/refresh", { body: { refresh_token: second.body.data.refresh_token } })).status).toBe(401);
  });

  it("revoke signs out (idempotent) and idle sessions expire after 30 days", async () => {
    const t = (await call(ctx, null, "POST", "/auth/tokens", { body: { email: org.teacher.email, password: "teacher-pass-1" } })).body.data;
    const out = await call(ctx, null, "POST", "/auth/tokens/revoke", { body: { refresh_token: t.refresh_token } });
    expect(out.status).toBe(200);
    expectContract(out, "post", "/auth/tokens/revoke");
    expect((await call(ctx, null, "POST", "/auth/tokens/revoke", { body: { refresh_token: t.refresh_token } })).status).toBe(200);
    expect((await call(ctx, null, "POST", "/auth/tokens/refresh", { body: { refresh_token: t.refresh_token } })).status).toBe(401);
    const idle = (await call(ctx, null, "POST", "/auth/tokens", { body: { email: org.teacher.email, password: "teacher-pass-1" } })).body.data;
    ctx.clock.now = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    try {
      expect((await call(ctx, null, "POST", "/auth/tokens/refresh", { body: { refresh_token: idle.refresh_token } })).status).toBe(401);
    } finally {
      ctx.clock.now = null;
    }
  });

  it("refuses accounts without an active membership", async () => {
    const disabled = await createUser(ctx.admin, org.orgId, "student", { active: false });
    await ctx.auth.register(disabled.email, "Some-pass-2026", disabled.userId);
    const res = await call(ctx, null, "POST", "/auth/tokens", { body: { email: disabled.email, password: "Some-pass-2026" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_DISABLED");
  });
});

describe("idempotency", () => {
  it("replays the stored response for the same key and rejects a different body", async () => {
    const s = await bearerCaller(org.student2.userId, org.orgId);
    const key = crypto.randomUUID();
    const first = await call(ctx, s, "POST", "/me/account-deletion", { idempotencyKey: key, body: { reason: "退職のため" } });
    const again = await call(ctx, s, "POST", "/me/account-deletion", { idempotencyKey: key, body: { reason: "退職のため" } });
    expect(first.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    const conflict = await call(ctx, s, "POST", "/me/account-deletion", { idempotencyKey: key, body: { reason: "別の理由" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
    const missing = await call(ctx, s, "POST", "/me/account-deletion", { idempotencyKey: false, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const { rows } = await ctx.admin.query("SELECT count(*)::int AS n FROM app.account_deletion_requests WHERE user_id = $1", [org.student2.userId]);
    expect(rows[0].n).toBe(1);
  });
});

describe("database boundary", () => {
  it("runs the API as a NOSUPERUSER NOBYPASSRLS role", async () => {
    const { rows } = await ctx.pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("isolates tenants with RLS even for raw queries", async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      const other = await seedOrg(ctx.admin);
      await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      const { rows } = await client.query("SELECT count(*)::int AS n FROM app.student_profiles WHERE org_id = $1", [other.orgId]);
      expect(rows[0].n).toBe(0);
      await expect(client.query("INSERT INTO app.programs(org_id, name) VALUES ($1, '越境')", [other.orgId])).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("does not allow the runtime role to rewrite the audit log", async () => {
    const client = await ctx.pool.connect();
    try {
      await expect(client.query("UPDATE app.audit_events SET event_type = 'x'")).rejects.toThrow(/permission denied/);
    } finally {
      client.release();
    }
  });
});

describe("cookie Secure flag follows the app origin", () => {
  it("refuses a non-HTTPS APP_ORIGIN in staging/production", async () => {
    const { loadConfig, ConfigError } = await import("../src/env");
    const base = {
      SUPABASE_URL: "https://x.invalid",
      SUPABASE_PUBLISHABLE_KEY: "k",
      SUPABASE_AUTH_ISSUER: "i",
      SUPABASE_AUTH_AUDIENCE: "a",
      SUPABASE_ADMIN_SECRET: "s",
      WEB_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      HYPERDRIVE: { connectionString: "postgres://x" } as never,
    };
    expect(() => loadConfig({ ...base, APP_ENV: "production", APP_ORIGIN: "http://arms.example.com" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, APP_ENV: "production", APP_ORIGIN: "https://arms.example.com" }).cookieSecure).toBe(true);
    expect(loadConfig({ APP_ENV: "development", APP_ORIGIN: "http://localhost:5188" }).cookieSecure).toBe(false);
  });
});

describe("deployment with incomplete configuration", () => {
  // Partial production deployment (e.g. the domain is live before the database/Auth exist): fail closed in Japanese.
  const partialEnv = { APP_ENV: "production", APP_ORIGIN: "https://arms.example.com", WEB_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };

  it("answers every API request with 503 NOT_CONFIGURED and never names secret values", async () => {
    const { createApp } = await import("../src/app");
    const { workerDeps } = await import("../src/deps");
    const app = createApp(workerDeps);
    for (const [method, path] of [["GET", "/api/v1/health"], ["GET", "/api/v1/auth/session"], ["POST", "/api/v1/auth/login"]] as const) {
      const res = await app.request(path, { method, headers: { origin: "https://arms.example.com", "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined }, partialEnv);
      const body = (await res.json()) as { code: string; message_ja: string; request_id: string };
      expect(res.status).toBe(503);
      expect(body.code).toBe("NOT_CONFIGURED");
      expect(body.message_ja).toMatch(/未設定/);
      expectContract({ status: res.status, body }, "get", "/health");
      expect(JSON.stringify(body)).not.toMatch(/SUPABASE|HYPERDRIVE|ENCRYPTION/);
      expect(res.headers.get("x-request-id")).toBe(body.request_id);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("skips scheduled jobs instead of failing every minute", async () => {
    const worker = (await import("../src/index")).default;
    const waited: Promise<unknown>[] = [];
    await expect(
      worker.scheduled({} as never, partialEnv as never, { waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException() {} } as never),
    ).resolves.toBeUndefined();
    expect(waited).toHaveLength(0);
  });
});
