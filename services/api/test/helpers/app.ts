import pg from "pg";
import { inject } from "vitest";
import { createApp } from "../../src/app";
import type { Deps } from "../../src/context";
import { poolSource } from "../../src/db/client";
import { createJwtVerifier } from "../../src/auth/jwt";
import { loadConfig } from "../../src/env";
import type { Integrations } from "../../src/integrations";
import { createWebSession } from "../../src/auth/session";
import { RequestDb } from "../../src/db/client";
import { TEST_AUDIENCE, TEST_ISSUER, TestAuthProvider, issueToken, testKeySet } from "./auth";

export const TEST_ORIGIN = "https://arms.test.invalid";
export const TEST_SESSION_KEY = Buffer.alloc(32, 7).toString("base64");

export interface TestContext {
  app: ReturnType<typeof createApp>;
  deps: Deps;
  auth: TestAuthProvider;
  /** Runtime-role pool (RLS enforced) — what the API uses. */
  pool: pg.Pool;
  /** Owner/superuser pool for fixtures and assertions that must bypass RLS. */
  admin: pg.Pool;
  integrations: Integrations;
  /** Mutable clock used by deps.now(). */
  clock: { now: Date | null };
  logs: Record<string, unknown>[];
  close(): Promise<void>;
}

export function createTestContext(overrides: Partial<Integrations> = {}): TestContext {
  const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 20 });
  const admin = new pg.Pool({ connectionString: inject("adminDatabaseUrl"), max: 5 });
  const auth = new TestAuthProvider();
  const integrations: Integrations = {
    storage: null,
    scanner: null,
    mail: null,
    push: null,
    queue: null,
    realtime: null,
    ...overrides,
  };
  const clock: { now: Date | null } = { now: null };
  const logs: Record<string, unknown>[] = [];
  const config = loadConfig({
    APP_ENV: "test",
    APP_ORIGIN: TEST_ORIGIN,
    SUPABASE_URL: "https://auth.test.invalid",
    SUPABASE_AUTH_ISSUER: TEST_ISSUER,
    SUPABASE_AUTH_AUDIENCE: TEST_AUDIENCE,
    WEB_SESSION_ENCRYPTION_KEY: TEST_SESSION_KEY,
  });
  const deps: Deps = {
    config,
    connections: poolSource(pool),
    jwt: createJwtVerifier({ keySet: testKeySet, issuer: TEST_ISSUER, audience: TEST_AUDIENCE }),
    auth,
    integrations,
    now: () => clock.now ?? new Date(),
    log: (e) => logs.push(e),
  };
  const app = createApp(() => deps);
  return {
    app,
    deps,
    auth,
    pool,
    admin,
    integrations,
    clock,
    logs,
    async close() {
      await pool.end();
      await admin.end();
    },
  };
}

export interface Caller {
  userId: string;
  orgId: string;
  headers(method: string): Record<string, string>;
}

/** Bearer caller (iOS style) for teachers/students. */
export async function bearerCaller(userId: string, orgId: string, opts: { aal?: "aal1" | "aal2" } = {}): Promise<Caller> {
  const token = await issueToken(userId, { aal: opts.aal });
  return { userId, orgId, headers: () => ({ Authorization: `Bearer ${token}` }) };
}

/** Cookie caller (Web BFF) with a real encrypted session row; admin sessions default to aal2 (MFA done). */
export async function cookieCaller(
  ctx: TestContext,
  user: { userId: string; orgId: string; role: "admin" | "teacher" | "student" },
  opts: { aal?: "aal1" | "aal2" } = {},
): Promise<Caller & { sessionId: string; csrfToken: string }> {
  const aal = opts.aal ?? (user.role === "admin" ? "aal2" : "aal1");
  const db = new RequestDb(ctx.deps.connections);
  const accessToken = await issueToken(user.userId, { aal });
  const s = await db.tx({ orgId: user.orgId, userId: user.userId }, (tx) =>
    createWebSession(tx, TEST_SESSION_KEY, {
      userId: user.userId,
      orgId: user.orgId,
      role: user.role,
      aal,
      accessToken,
      refreshToken: crypto.randomUUID(),
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      now: new Date(),
    }),
  );
  await db.close();
  return {
    userId: user.userId,
    orgId: user.orgId,
    sessionId: s.sessionId,
    csrfToken: s.csrfToken,
    headers: (method: string) => ({
      Cookie: `arms_session=${s.sessionId}`,
      ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { "X-CSRF-Token": s.csrfToken, Origin: TEST_ORIGIN } : {}),
    }),
  };
}

export interface CallOptions {
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string | false;
  ifMatch?: number;
}

/** Calls the API in-process. Mutations get a fresh Idempotency-Key unless one is supplied or disabled. */
export async function call(ctx: TestContext, caller: Caller | null, method: string, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { ...(caller?.headers(method) ?? {}), ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method === "POST" || method === "PUT") {
    if (opts.idempotencyKey !== false) headers["Idempotency-Key"] = opts.idempotencyKey ?? crypto.randomUUID();
  }
  if (opts.ifMatch !== undefined) headers["If-Match"] = `"${opts.ifMatch}"`;
  const res = await ctx.app.request(`/api/v1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
