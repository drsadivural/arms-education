import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ORIGIN, bearerCaller, call, cookieCaller, createTestContext, type TestContext } from "./helpers/app";
import { TEST_TOTP_CODE, issueToken } from "./helpers/auth";
import { createUser, seedOrg, type OrgScenario } from "./helpers/fixtures";
import { expectContract } from "./helpers/contract";

let ctx: TestContext;
let org: OrgScenario;

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  ctx.auth.register(org.admin.email, "admin-pass-1", org.admin.userId);
  ctx.auth.register(org.teacher.email, "teacher-pass-1", org.teacher.userId);
  ctx.auth.register(org.student.email, "student-pass-1", org.student.userId);
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
    // The cookie value is never stored in the DB (only its SHA-256), and tokens are encrypted at rest.
    const { rows } = await ctx.admin.query("SELECT id, encrypted_provider_tokens FROM app.web_sessions WHERE user_id = $1", [org.teacher.userId]);
    expect(rows.some((r) => r.id === cookie)).toBe(false);
    // Stored tokens are AES-GCM ciphertext ("v1.<iv>.<ct>"), never the JWT itself.
    expect(rows.every((r) => /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(r.encrypted_provider_tokens)))).toBe(true);
    expect(rows.every((r) => !/eyJ[A-Za-z0-9_-]+\.eyJ/.test(String(r.encrypted_provider_tokens)))).toBe(true);

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

    const wrong = await call(ctx, null, "POST", "/auth/mfa/verify", { headers: h, body: { code: "000000" } });
    expect(wrong.status).toBe(422);

    const verify = await call(ctx, null, "POST", "/auth/mfa/verify", { headers: h, body: { code: TEST_TOTP_CODE } });
    expect(verify.status).toBe(200);
    expect(verify.body.data.mfa_required).toBe(false);
    expectContract(verify, "post", "/auth/mfa/verify");

    const allowed = await call(ctx, null, "PATCH", "/me/preferences", { headers: h, ifMatch: 0, body: { theme: "dark", notifications_enabled: true } });
    expect(allowed.status).toBe(200);
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

  it("password reset never reveals whether an address exists", async () => {
    const a = await call(ctx, null, "POST", "/auth/password-reset", { body: { email: org.teacher.email } });
    const b = await call(ctx, null, "POST", "/auth/password-reset", { body: { email: "nobody@example.invalid" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data).toEqual(b.body.data);
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
    const token = await issueToken(org.teacher.userId);
    const res = await call(ctx, null, "GET", "/me", { headers: { Cookie: `arms_session=${t.sessionId}`, Authorization: `Bearer ${token}` } });
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

  it("rejects forged, expired, wrong-issuer and wrong-audience tokens", async () => {
    for (const token of [
      await issueToken(org.student.userId, { forged: true }),
      await issueToken(org.student.userId, { expiresInSeconds: -120 }),
      await issueToken(org.student.userId, { issuer: "https://evil.example/auth/v1" }),
      await issueToken(org.student.userId, { audience: "anon" }),
      "not.a.jwt",
    ]) {
      const res = await call(ctx, null, "GET", "/me", { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
    }
  });

  it("rejects disabled users even with a valid unexpired JWT", async () => {
    const disabled = await createUser(ctx.admin, org.orgId, "student", { active: false });
    const s = await bearerCaller(disabled.userId, org.orgId);
    const res = await call(ctx, s, "GET", "/me");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_DISABLED");
  });

  it("rejects users without membership and spoofed organisation headers", async () => {
    const stranger = await bearerCaller(crypto.randomUUID(), org.orgId);
    expect((await call(ctx, stranger, "GET", "/me")).status).toBe(403);
    const other = await seedOrg(ctx.admin);
    const s = await bearerCaller(org.student.userId, org.orgId);
    const spoof = await call(ctx, s, "GET", "/me", { headers: { "X-ARMS-Org": other.orgId } });
    expect(spoof.status).toBe(403);
  });

  it("keeps administrators on the Web (MFA-protected) channel", async () => {
    const a = await bearerCaller(org.admin.userId, org.orgId, { aal: "aal2" });
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
