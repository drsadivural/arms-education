import { Hono } from "hono";
import type { AppEnv } from "../context";

/** Programs, versions, units, materials, uploads, quizzes, submissions, enrollments, progress and exports (WEB-09〜12, IOS-04〜06, IOS-12). */
export const learningRoutes = new Hono<AppEnv>();
