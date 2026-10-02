import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { installJapaneseErrors } from "@arms/contracts";
import type { AppEnv, Deps } from "./context";
import { RequestDb } from "./db/client";
import { ConfigError } from "./env";
import { ApiError, mapDbError } from "./http/errors";
import { registerRoutes } from "./routes";

installJapaneseErrors();

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Robots-Tag": "noindex, nofollow",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export type DepsProvider = (env: AppEnv["Bindings"]) => Deps;

/** Builds the API application. `getDeps` is per-isolate in Workers and injected in tests. */
export function createApp(getDeps: DepsProvider): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    let deps: Deps;
    try {
      deps = getDeps(c.env);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      // A deployment whose secrets/bindings are not all registered yet: fail closed with a Japanese 503 instead of
      // a generic 500. The message names missing keys only, never values.
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "configuration_incomplete", request_id: requestId, detail: err.message }));
      const notConfigured = new ApiError("NOT_CONFIGURED");
      c.res = c.json({ code: notConfigured.code, message_ja: notConfigured.message_ja, request_id: requestId }, 503);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
      c.res.headers.set("X-Request-Id", requestId);
      return;
    }
    c.set("deps", deps);
    const db = new RequestDb(deps.connections);
    c.set("db", db);
    try {
      await next();
    } finally {
      await db.close();
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
      c.res.headers.set("X-Request-Id", requestId);
      const actor = c.var.actor;
      deps.log({
        level: c.res.status >= 500 ? "error" : "info",
        msg: "request",
        request_id: requestId,
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        duration_ms: Date.now() - started,
        role: actor?.role,
        org_id: actor?.orgId,
      });
    }
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    let apiError: ApiError;
    if (err instanceof ApiError) apiError = err;
    else if (err instanceof HTTPException) apiError = new ApiError(err.status === 401 ? "UNAUTHENTICATED" : "BAD_REQUEST");
    else apiError = mapDbError(err) ?? new ApiError("INTERNAL", { cause: err });
    if (apiError.status >= 500) {
      const cause = (apiError.cause ?? err) as { name?: string; code?: string; message?: string };
      c.get("deps")?.log({
        level: "error",
        msg: "request_failed",
        request_id: requestId,
        code: apiError.code,
        error_name: cause?.name,
        error_code: cause?.code,
        // Driver/provider messages may contain SQL but never credentials; keep them out of responses only.
        error_message: typeof cause?.message === "string" ? cause.message.slice(0, 300) : undefined,
      });
    }
    return c.json(
      {
        code: apiError.code,
        message_ja: apiError.message_ja,
        request_id: requestId,
        ...(apiError.field_errors ? { field_errors: apiError.field_errors } : {}),
        ...(apiError.details ? { details: apiError.details } : {}),
      },
      apiError.status as 400,
    );
  });

  app.notFound((c) =>
    c.json({ code: "NOT_FOUND", message_ja: "対象が見つかりません。", request_id: c.get("requestId") ?? crypto.randomUUID() }, 404),
  );

  const api = new Hono<AppEnv>();
  registerRoutes(api);
  app.route("/api/v1", api);
  return app;
}
