import pg from "pg";
import { inject } from "vitest";
import { createApp } from "../../src/app";
import type { Deps } from "../../src/context";
import { poolSource } from "../../src/db/client";
import { loadConfig } from "../../src/env";
import type { Integrations } from "../../src/integrations";
import { createWebSession } from "../../src/auth/session";
import { issueBearerSession } from "../../src/auth/tokens";
import { sql } from "../../src/db/sql";
import { RequestDb } from "../../src/db/client";
import { TestAuthKit, TestMailer } from "./auth";

export const TEST_ORIGIN = "https://arms.test.invalid";
export const TEST_SESSION_KEY = Buffer.alloc(32, 7).toString("base64");

export interface TestContext {
  app: ReturnType<typeof createApp>;
  deps: Deps;
  /** Credentials / sent e-mails (real DB rows; the mailer captures invitation and reset e-mails). */
  auth: TestAuthKit;
  mailer: TestMailer;
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
  const mailer = new TestMailer();
  const auth = new TestAuthKit(admin, mailer);
  const integrations: Integrations = {
    storage: null,
    scanner: null,
    mail: mailer,
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
    WEB_SESSION_ENCRYPTION_KEY: TEST_SESSION_KEY,
  });
  const deps: Deps = {
    config,
    connections: poolSource(pool),
    integrations,
    now: () => clock.now ?? new Date(),
    log: (e) => logs.push(e),
  };
  const app = createApp(() => deps);
  return {
    app,
    deps,
    auth,
    mailer,
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

let helperPool: pg.Pool | null = null;
/** Runtime-role pool for fixture sessions (exits with the worker when idle). */
function fixturePool(): pg.Pool {
  helperPool ??= new pg.Pool({ connectionString: inject("databaseUrl"), max: 4, allowExitOnIdle: true });
  return helperPool;
}

/**
 * Bearer caller (iOS style) for teachers/students: a real bearer session row and its opaque access token. The fixture
 * session is valid for 400 days so tests that move deps.now() forward keep their caller; token expiry itself is
 * tested with tokens from POST /auth/tokens.
 */
export async function bearerCaller(userId: string, orgId: string): Promise<Caller & { accessToken: string; refreshToken: string }> {
  const db = new RequestDb(poolSource(fixturePool()));
  const tokens = await db.tx({}, async (tx) => {
    const t = await issueBearerSession(tx, userId, "test", new Date());
    await tx.exec(sql`UPDATE app.bearer_sessions SET access_expires_at = now() + interval '400 days', expires_at = now() + interval '400 days'
      WHERE user_id = ${userId} AND device_label = 'test' AND access_expires_at <= now() + interval '2 hours'`);
    return t;
  });
  await db.close();
  return { userId, orgId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, headers: () => ({ Authorization: `Bearer ${tokens.accessToken}` }) };
}

/** Cookie caller (Web BFF) with a real encrypted session row; admin sessions default to aal2 (MFA done). */
export async function cookieCaller(
  ctx: TestContext,
  user: { userId: string; orgId: string; role: "admin" | "teacher" | "student" },
  opts: { aal?: "aal1" | "aal2" } = {},
): Promise<Caller & { sessionId: string; csrfToken: string }> {
  const aal = opts.aal ?? (user.role === "admin" ? "aal2" : "aal1");
  const db = new RequestDb(ctx.deps.connections);
  const s = await db.tx({ orgId: user.orgId, userId: user.userId }, (tx) =>
    createWebSession(tx, TEST_SESSION_KEY, { userId: user.userId, orgId: user.orgId, role: user.role, aal, now: new Date() }),
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
