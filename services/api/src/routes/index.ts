import type { Hono } from "hono";
import type { AppEnv } from "../context";
import { authenticate } from "../auth/middleware";
import { healthRoutes } from "./health";
import { authRoutes } from "./auth";
import { meRoutes } from "./me";
import { adminRoutes } from "./admin";
import { learningRoutes } from "./learning";
import { bookingRoutes } from "./booking";
import { voiceRoutes } from "./voice";
import { importsRoutes } from "./imports";

/** Endpoints reachable without credentials. Everything else is authenticated (default deny). */
const PUBLIC_ENDPOINTS = new Set(["GET /api/v1/health", "POST /api/v1/auth/login", "POST /api/v1/auth/password-reset"]);

export function registerRoutes(api: Hono<AppEnv>): void {
  api.use("*", async (c, next) => {
    if (PUBLIC_ENDPOINTS.has(`${c.req.method} ${c.req.path}`)) return next();
    return authenticate(c, next);
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
