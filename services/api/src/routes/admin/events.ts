/**
 * WEB-19 ログ・イベント: audit log search (details redacted) and the notification delivery monitor
 * (read-only view of app.outbox; delivery itself belongs to the notifications worker) with manual retry.
 */
import { Hono } from "hono";
import { z } from "zod";
import { zDate, zId, zonedDayRange, type components } from "@arms/contracts";
import type { AppEnv } from "../../context";
import { actorTx } from "../../context";
import { and, sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { fail } from "../../http/errors";
import { pathId, readQuery } from "../../http/validation";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { action, page } from "../../http/respond";
import { TimeIdCursor, audit, containsPattern, optionalQuery, prefixPattern, zQueryText } from "../../domain/admin/common";
import { redact } from "../../domain/admin/redact";

export const eventRoutes = new Hono<AppEnv>();

type AuditEvent = components["schemas"]["AuditEvent"];
type Delivery = components["schemas"]["Delivery"];

const EventQuery = z
  .object({
    cursor: optionalQuery(z.string().max(1000)),
    limit: optionalQuery(z.string()),
    q: optionalQuery(zQueryText),
    event_type: optionalQuery(z.string().trim().max(100)),
    actor_id: optionalQuery(zId),
    entity_id: optionalQuery(zId),
    from: optionalQuery(zDate),
    to: optionalQuery(zDate),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "終了日は開始日以降にしてください。" });

eventRoutes.get("/events", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const query = readQuery(c, EventQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, TimeIdCursor);
  const from = query.from ? zonedDayRange(query.from, actor.timezone).start : null;
  const to = query.to ? zonedDayRange(query.to, actor.timezone).end : null;
  const like = query.q ? containsPattern(query.q) : null;
  const rows = await actorTx(c, (tx) =>
    tx.query<{ id: string; actor_id: string | null; actor_name: string | null; event_type: string; entity_id: string | null; created_at: Date; payload: unknown; cursor_t: string }>(sql`
      SELECT e.id, e.actor_id, u.display_name AS actor_name, e.event_type, e.entity_id, e.created_at, e.payload, e.created_at::text AS cursor_t
      FROM app.audit_events e
      LEFT JOIN app.users u ON u.id = e.actor_id
      WHERE ${and([
        sql`e.org_id = ${actor.orgId}`,
        like ? sql`(e.event_type ILIKE ${like} ESCAPE '\\' OR u.display_name ILIKE ${like} ESCAPE '\\')` : null,
        query.event_type ? sql`e.event_type LIKE ${prefixPattern(query.event_type)} ESCAPE '\\'` : null,
        query.actor_id ? sql`e.actor_id = ${query.actor_id}` : null,
        query.entity_id ? sql`e.entity_id = ${query.entity_id}` : null,
        from ? sql`e.created_at >= ${from}` : null,
        to ? sql`e.created_at < ${to}` : null,
        after ? sql`(e.created_at, e.id) < (${after.t}::timestamptz, ${after.id}::uuid)` : null,
      ])}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit + 1}`),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ t: r.cursor_t, id: r.id }));
  const events: AuditEvent[] = items.map((r) => {
    const details = redact(r.payload);
    return {
      id: r.id,
      actor_id: r.actor_id,
      actor_name: r.actor_name ?? "システム",
      event_type: r.event_type,
      entity_id: r.entity_id,
      created_at: r.created_at.toISOString(),
      details: details !== null && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : { value: details },
    };
  });
  return page(c, events, nextCursor);
});

const DeliveryQuery = z.object({
  cursor: optionalQuery(z.string().max(1000)),
  limit: optionalQuery(z.string()),
  state: optionalQuery(z.enum(["pending", "processing", "delivered", "failed"])),
});

/** Error codes look like DELIVERY_TIMEOUT; free-text provider messages are not shown (they may contain addresses). */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

eventRoutes.get("/events/deliveries", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const query = readQuery(c, DeliveryQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, TimeIdCursor);
  // last_error_code / last_error / delivered_at are optional columns added by the notifications module; reading
  // them through to_jsonb() keeps this view working whether or not they exist.
  const rows = await actorTx(c, (tx) =>
    tx.query<{
      id: string;
      event_type: string;
      entity_id: string;
      state: Delivery["state"];
      attempts: number;
      next_attempt_at: Date;
      locked_until: Date | null;
      created_at: Date;
      cursor_t: string;
      last_error_code: string | null;
      last_error: string | null;
      delivered_at: string | null;
    }>(sql`
      SELECT o.id, o.event_type, o.entity_id, o.state, o.attempts, o.next_attempt_at, o.locked_until, o.created_at, o.created_at::text AS cursor_t,
        to_jsonb(o) ->> 'last_error_code' AS last_error_code, to_jsonb(o) ->> 'last_error' AS last_error, to_jsonb(o) ->> 'delivered_at' AS delivered_at
      FROM app.outbox o
      WHERE ${and([
        sql`o.org_id = ${actor.orgId}`,
        query.state ? sql`o.state = ${query.state}` : null,
        after ? sql`(o.created_at, o.id) < (${after.t}::timestamptz, ${after.id}::uuid)` : null,
      ])}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit + 1}`),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ t: r.cursor_t, id: r.id }));
  const deliveries: Delivery[] = items.map((r) => {
    const code = [r.last_error_code, r.last_error].find((v) => typeof v === "string" && ERROR_CODE_RE.test(v)) ?? null;
    return {
      id: r.id,
      event_type: r.event_type,
      entity_id: r.entity_id,
      state: r.state,
      attempts: r.attempts,
      last_error_code: code,
      next_attempt_at: r.next_attempt_at.toISOString(),
      locked_until: r.locked_until ? r.locked_until.toISOString() : null,
      delivered_at: isoOrNull(r.delivered_at),
      created_at: r.created_at.toISOString(),
    };
  });
  return page(c, deliveries, nextCursor);
});

/** Manual retry of a failed delivery: back to pending, due now. Other states are left to the worker. */
eventRoutes.post("/events/deliveries/:id/retry", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const row = await actorTx(c, async (tx) => {
    const updated = await tx.maybeOne<{ id: string; event_type: string; attempts: number }>(sql`
      UPDATE app.outbox SET state = 'pending', next_attempt_at = now(), locked_until = NULL
      WHERE org_id = ${actor.orgId} AND id = ${id} AND state = 'failed' RETURNING id, event_type, attempts`);
    if (!updated) {
      const exists = await tx.maybeOne(sql`SELECT 1 FROM app.outbox WHERE org_id = ${actor.orgId} AND id = ${id}`);
      if (!exists) fail("NOT_FOUND");
      fail("INVALID_STATE", { message_ja: "送信失敗の通知のみ再送できます。最新の状態を確認してください。" });
    }
    await audit(tx, actor, "notification.retry_requested", id, { event_type: updated.event_type, attempts: updated.attempts });
    return updated;
  });
  return action(c, { id: row.id, state: "pending" });
});
