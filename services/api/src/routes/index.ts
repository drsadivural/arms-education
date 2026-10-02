import type { Hono } from "hono";
import type { AppEnv } from "../context";
import { authenticate } from "../auth/middleware";
import { rateLimit } from "../http/rate-limit";
import { healthRoutes } from "./health";
import { authRoutes } from "./auth";
import { meRoutes } from "./me";
import { adminRoutes } from "./admin";
import { learningRoutes } from "./learning";
import { bookingRoutes } from "./booking";
import { voiceRoutes } from "./voice";
import { importsRoutes } from "./imports";

/** Endpoints reachable without credentials. Everything else is authenticated (default deny). */
const PUBLIC_ENDPOINTS = new Set(["GET /api/v1/health", "POST /api/v1/auth/login", "POST /api/v1/auth/password-reset", "POST /api/v1/auth/password"]);
/**
 * Machine-to-machine callbacks authenticated by their own signature instead of a user session:
 * the malware scanner's verdict callback (HMAC-SHA256 with the scanner key, ±300 s timestamp window).
 */
const PUBLIC_PATTERNS = [/^POST \/api\/v1\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/scan-result$/i];

export function registerRoutes(api: Hono<AppEnv>): void {
  api.use("*", async (c, next) => {
    const key = `${c.req.method} ${c.req.path}`;
    if (PUBLIC_ENDPOINTS.has(key) || PUBLIC_PATTERNS.some((re) => re.test(key))) return next();
    return authenticate(c, async () => {
      // Per-user ceiling across the whole API (Workers Rate Limiting binding; absent in tests/local).
      await rateLimit(c, "api", `user:${c.get("actor").userId}`);
      await next();
    });
  });
  api.route("/", healthRoutes);
  api.route("/", authRoutes);
  api.route("/", meRoutes);
  api.route("/", adminRoutes);
  api.route("/", learningRoutes);
  api.route("/", bookingRoutes);
  api.route("/", voiceRoutes);
  api.route("/", importsRoutes);
}
