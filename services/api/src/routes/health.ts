import { Hono } from "hono";
import type { AppEnv } from "../context";
import { sql } from "../db/sql";
import { action } from "../http/respond";

export const healthRoutes = new Hono<AppEnv>();

/** Liveness + DB reachability. Returns 503 DB_UNAVAILABLE (via the error mapper) when the DB is down. */
healthRoutes.get("/health", async (c) => {
  const row = await c.get("db").tx({}, (tx) => tx.one<{ ok: number }>(sql`SELECT 1 AS ok`));
  return action(c, { database: row.ok === 1 ? "ok" : "error", environment: c.get("deps").config.env });
});
