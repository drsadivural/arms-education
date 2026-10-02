import { Hono } from "hono";
import type { AppEnv } from "../context";

/** Lesson slots, reservations, attendance, today's lessons, notifications and devices (WEB-13〜15, IOS-07〜11, IOS-15〜17). */
export const bookingRoutes = new Hono<AppEnv>();
