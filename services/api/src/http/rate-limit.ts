import type { AppContext } from "../context";
import { sha256Hex } from "../auth/crypto";
import { fail } from "./errors";

/**
 * Cloudflare Workers Rate Limiting bindings (configured in wrangler.jsonc for every deployed environment).
 * Keys are hashed so e-mail addresses never reach the limiter.
 */
export async function rateLimit(c: AppContext, bucket: "login" | "api", key: string): Promise<void> {
  const limiter = bucket === "login" ? c.env?.LOGIN_RATE_LIMITER : c.env?.API_RATE_LIMITER;
  if (!limiter) return;
  const { success } = await limiter.limit({ key: await sha256Hex(`${bucket}:${key}`) });
  if (!success) fail("RATE_LIMITED");
}
