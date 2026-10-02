import { z } from "zod";
import { zId } from "@arms/contracts";
import type { AppContext } from "../../context";
import type { BookingScope, TxWrapper } from "../../domain/booking/common";
import { enqueueAfterCommit } from "../../domain/notifications/outbox";
import { idempotent } from "../../http/idempotency";

/** Booking scope for a request: after-commit outbox wake-ups use waitUntil in Workers. */
export function bookingScope(c: AppContext): BookingScope {
  const deps = c.get("deps");
  const actor = c.get("actor");
  return { db: c.get("db"), deps, actor, afterCommit: (ids) => enqueueAfterCommit(c, deps, actor.orgId, ids) };
}

/** HTTP idempotency (app.idempotency_requests) in the same transaction as the domain write. */
export function httpIdempotency(c: AppContext, input: unknown): TxWrapper {
  return (tx, work) => idempotent(c, tx, input, work);
}

/** Replays/returns a stored response; echoes row_version as ETag when the body carries one. */
export function respondStored(c: AppContext, stored: { status: number; body: unknown }) {
  const body = stored.body as { data?: { row_version?: unknown }; row_version?: unknown };
  const version = body?.data?.row_version ?? body?.row_version;
  if (typeof version === "number") c.header("ETag", `"${version}"`);
  return c.json(stored.body as object, stored.status as 200);
}

/** Keyset cursor {k: ISO timestamp, id}. */
export const KeyCursor = z.object({
  k: z.string().max(64).refine((v) => !Number.isNaN(Date.parse(v))),
  id: zId,
});

export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "YYYY-MM形式で指定してください。" });
