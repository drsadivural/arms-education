import type { AppContext } from "../context";
import type { Tx } from "../db/client";
import { json } from "../db/client";
import { sql } from "../db/sql";
import { sha256Hex } from "../auth/crypto";
import { ApiError, fail } from "./errors";
import { isUuid } from "./validation";

export function requireIdempotencyKey(c: AppContext): string {
  const key = c.req.header("Idempotency-Key");
  if (!isUuid(key)) fail("IDEMPOTENCY_KEY_REQUIRED");
  return key.toLowerCase();
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export interface StoredResponse<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Server-side idempotency (app.idempotency_requests) in the same transaction as the mutation:
 * same key + same request → stored response; same key + different request → 409 IDEMPOTENCY_CONFLICT.
 * If the handler fails the transaction rolls back together with the key, so a retry re-executes.
 */
export async function idempotent<T>(
  c: AppContext,
  tx: Tx,
  request: unknown,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<StoredResponse<T>> {
  const actor = c.get("actor");
  const key = requireIdempotencyKey(c);
  const route = `${c.req.method} ${c.req.path}`;
  const hash = await sha256Hex(stableStringify({ route, request }));
  const inserted = await tx.query(sql`
    INSERT INTO app.idempotency_requests(org_id, user_id, route, key, request_hash)
    VALUES (${actor.orgId}, ${actor.userId}, ${route}, ${key}, ${hash})
    ON CONFLICT DO NOTHING RETURNING key`);
  if (inserted.length === 0) {
    const existing = await tx.one<{ request_hash: string; response: T | null; status_code: number | null; expired: boolean }>(sql`
      SELECT request_hash, response, status_code, expires_at <= now() AS expired FROM app.idempotency_requests
      WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND route = ${route} AND key = ${key} FOR UPDATE`);
    if (existing.expired) {
      await tx.exec(sql`UPDATE app.idempotency_requests SET request_hash = ${hash}, response = NULL, status_code = NULL,
        created_at = now(), expires_at = now() + interval '24 hours'
        WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND route = ${route} AND key = ${key}`);
    } else {
      if (existing.request_hash !== hash) throw new ApiError("IDEMPOTENCY_CONFLICT");
      if (existing.response === null || existing.status_code === null) throw new ApiError("IDEMPOTENCY_IN_PROGRESS");
      return { status: existing.status_code, body: existing.response, replayed: true };
    }
  }
  const result = await handler();
  await tx.exec(sql`UPDATE app.idempotency_requests SET response = ${json(result.body)}::jsonb, status_code = ${result.status}
    WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND route = ${route} AND key = ${key}`);
  return { ...result, replayed: false };
}
