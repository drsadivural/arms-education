import { Hono } from "hono";
import type { AppEnv } from "../context";

/** OpenAI Realtime voice sessions and server-enforced tool calls (IOS-13/14). */
export const voiceRoutes = new Hono<AppEnv>();
