import { Hono } from "hono";
import type { AppEnv } from "../context";

/** Legacy data migration: CSV upload, mapping, dry run, commit and rollback (WEB-17). */
export const importsRoutes = new Hono<AppEnv>();
