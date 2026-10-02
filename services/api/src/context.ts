import type { Context } from "hono";
import type { Bindings, Config } from "./env";
import type { ConnectionSource, RequestDb, Tx } from "./db/client";
import type { Integrations } from "./integrations";

export type Role = "admin" | "teacher" | "student";

/** The authenticated caller. Every field is derived from verified credentials + DB membership. */
export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
  orgName: string;
  timezone: string;
  displayName: string;
  method: "cookie" | "bearer";
  /** SHA-256 of the web session id (cookie auth only). */
  sessionHash: string | null;
  aal: "aal1" | "aal2";
}

/** Process-wide dependencies (built once per isolate in Workers, injected in tests). */
export interface Deps {
  config: Config;
  connections: ConnectionSource;
  integrations: Integrations;
  now(): Date;
  log(event: Record<string, unknown>): void;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    deps: Deps;
    db: RequestDb;
    requestId: string;
    actor: Actor;
  };
}

export type AppContext = Context<AppEnv>;

/** Runs `fn` in a transaction with the caller's tenant + user context (RLS + SQL-function authorisation). */
export function actorTx<T>(c: AppContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const actor = c.get("actor");
  return c.get("db").tx({ orgId: actor.orgId, userId: actor.userId }, fn);
}

export function nowIso(c: AppContext): string {
  return c.get("deps").now().toISOString();
}
