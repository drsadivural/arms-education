/**
 * Shared plumbing for the booking domain. Domain functions take a BookingScope (db + deps + actor) instead of
 * the Hono context so the voice assistant can call the same services with the same authorisation.
 */
import type { Actor, Deps } from "../../context";
import type { RequestDb, Tx } from "../../db/client";
import { ident, sql, type SqlFragment } from "../../db/sql";
import { enqueueOutbox, newOutboxIds } from "../notifications/outbox";

export interface BookingScope {
  db: RequestDb;
  deps: Deps;
  actor: Actor;
  /**
   * Called after every committed transaction that inserted outbox rows (best-effort wake-up of the
   * notification dispatcher). Defaults to enqueueing directly on the notification queue.
   */
  afterCommit?: (outboxIds: string[]) => Promise<void>;
}

/**
 * Runs `fn` in one transaction with the actor's tenant + user context; after COMMIT, hands the outbox rows
 * it inserted to `afterCommit`. A failing wake-up never affects the committed result.
 */
export async function bookingTx<T>(b: BookingScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { value, outboxIds } = await b.db.tx({ orgId: b.actor.orgId, userId: b.actor.userId }, async (tx) => {
    const value = await fn(tx);
    return { value, outboxIds: await newOutboxIds(tx, b.actor.orgId) };
  });
  if (outboxIds.length > 0) {
    await (b.afterCommit ? b.afterCommit(outboxIds) : enqueueOutbox(b.deps, b.actor.orgId, outboxIds)).catch(() => undefined);
  }
  return value;
}

/** Wraps the body of a write so the HTTP layer can apply its idempotency store in the same transaction. */
export type TxWrapper = <T>(tx: Tx, work: () => Promise<{ status: number; body: T }>) => Promise<{ status: number; body: T }>;
export const directTx: TxWrapper = (_tx, work) => work();

export const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
export const isoOrNull = (v: Date | string | null | undefined): string | null => (v === null || v === undefined ? null : iso(v));

/** LIKE pattern for a user search term (wildcards escaped; use with ESCAPE '\'). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * Status as seen by readers: a pending row whose hold expired is reported as 'expired' even before the
 * minute cron or a lazy expiry commits it (seats are already released by the same rule in remaining).
 */
export const effectiveStatus = (alias: string): SqlFragment => {
  const a = ident(alias);
  return sql`(CASE WHEN ${a}.status = 'pending' AND ${a}.expires_at <= now() THEN 'expired' ELSE ${a}.status END)`;
};

/** Keyset cursor value for a timestamptz column with full microsecond precision (ISO 8601 text). */
export const tsKey = (column: string): SqlFragment => sql`(to_json(${ident(column)}) #>> '{}')`;

/** Splits a comma-separated filter against an allowlist; returns null when absent, throws via `onInvalid`. */
export function parseList<T extends string>(value: string | undefined, allowed: readonly T[], onInvalid: () => never): T[] | null {
  if (value === undefined || value.trim() === "") return null;
  const parts = [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
  if (parts.length === 0 || parts.some((p) => !(allowed as readonly string[]).includes(p))) onInvalid();
  return parts as T[];
}
