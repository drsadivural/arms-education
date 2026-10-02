import { Hono } from "hono";
import type { AppEnv } from "../context";

/** Teachers, students, classrooms, dashboard, settings, user management and audit events (WEB-02〜08, WEB-16, WEB-18, WEB-19). */
export const adminRoutes = new Hono<AppEnv>();
