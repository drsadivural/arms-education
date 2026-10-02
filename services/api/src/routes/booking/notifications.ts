/** In-app notifications and APNs device registration (IOS-15, IOS-18). */
import { Hono } from "hono";
import { z } from "zod";
import { DeviceInput, NOTIFICATION_FILTERS, zDeviceTokenHash } from "@arms/contracts";
import type { AppEnv } from "../../context";
import { actorTx } from "../../context";
import { requireRole } from "../../auth/middleware";
import { json } from "../../db/client";
import { and, sql } from "../../db/sql";
import { iso, isoOrNull, tsKey } from "../../domain/booking/common";
import { deviceTokenAad, deviceTokenHash } from "../../domain/notifications/devices";
import { fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { action, page } from "../../http/respond";
import { pathId, readBody, readQuery } from "../../http/validation";
import { KeyCursor, respondStored } from "./shared";

export const notificationRoutes = new Hono<AppEnv>();

const NotificationQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.string().optional(),
  status: z.enum(NOTIFICATION_FILTERS).optional(),
});

/** GET /notifications — own notifications, newest first; status=unread|read filters. */
notificationRoutes.get("/notifications", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const q = readQuery(c, NotificationQuery);
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, KeyCursor);
  const status = q.status ?? "all";
  const rows = await actorTx(c, (tx) =>
    tx.query<{ id: string; title: string; body: string; deep_link: string; read_at: Date | null; created_at: Date; k: string }>(sql`
      SELECT n.id, n.title, n.body, n.deep_link, n.read_at, n.created_at, ${tsKey("n.created_at")} AS k
      FROM app.notifications n
      WHERE ${and([
        sql`n.org_id = ${actor.orgId}`,
        sql`n.user_id = ${actor.userId}`,
        status === "unread" && sql`n.read_at IS NULL`,
        status === "read" && sql`n.read_at IS NOT NULL`,
        cursor && sql`(n.created_at, n.id) < (${cursor.k}::timestamptz, ${cursor.id}::uuid)`,
      ])}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${limit + 1}`),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ k: r.k, id: r.id }));
  return page(
    c,
    items.map((n) => ({ id: n.id, title: n.title, body: n.body, deep_link: n.deep_link, read_at: isoOrNull(n.read_at), created_at: iso(n.created_at) })),
    nextCursor,
  );
});

/** POST /notifications/read-all — marks every unread notification of the caller as read. */
notificationRoutes.post("/notifications/read-all", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const updated = await actorTx(c, (tx) =>
    tx.exec(sql`UPDATE app.notifications SET read_at = now() WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND read_at IS NULL`),
  );
  return action(c, { updated });
});

/** POST /notifications/{id}/read — own notifications only (others → 404). Idempotent. */
notificationRoutes.post("/notifications/:id/read", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const row = await actorTx(c, (tx) =>
    tx.maybeOne<{ read_at: Date }>(sql`
      UPDATE app.notifications SET read_at = coalesce(read_at, now())
      WHERE org_id = ${actor.orgId} AND id = ${id} AND user_id = ${actor.userId}
      RETURNING read_at`),
  );
  if (!row) fail("NOT_FOUND");
  return action(c, { id, read_at: iso(row.read_at) });
});

/**
 * POST /devices — registers the caller's APNs token: sha256 hash + AES-GCM sealed token. A token belongs to
 * the most recent user who registered it on this organisation (other users' rows for it are removed).
 */
notificationRoutes.post("/devices", requireRole("teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const push = c.get("deps").integrations.push;
  const input = await readBody(c, DeviceInput);
  if (!push) fail("NOT_CONFIGURED");
  const token = input.token.toLowerCase();
  const hash = await deviceTokenHash(token);
  const sealed = await push.sealToken(token, deviceTokenAad(actor.orgId, actor.userId, hash));
  const stored = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      await tx.exec(sql`DELETE FROM app.device_tokens WHERE org_id = ${actor.orgId} AND token_hash = ${hash} AND user_id <> ${actor.userId}`);
      const inserted = await tx.one<{ created: boolean }>(sql`
        INSERT INTO app.device_tokens(org_id, user_id, token_hash, encrypted_token, environment)
        VALUES (${actor.orgId}, ${actor.userId}, ${hash}, ${sealed}, ${input.environment})
        ON CONFLICT (org_id, user_id, token_hash) DO UPDATE SET encrypted_token = EXCLUDED.encrypted_token,
          environment = EXCLUDED.environment, updated_at = now()
        RETURNING (xmax = 0) AS created`);
      if (inserted.created) {
        await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
          VALUES (${actor.orgId}, ${actor.userId}, 'device.registered', ${actor.userId}, ${json({ environment: input.environment })}::jsonb)`);
      }
      return { status: 200, body: { success: true, checked_at: c.get("deps").now().toISOString(), data: { token_hash: hash, environment: input.environment } } };
    }),
  );
  return respondStored(c, stored);
});

/** DELETE /devices/{token_hash} — unregisters the caller's device (logout). Idempotent; no If-Match (not versioned). */
notificationRoutes.delete("/devices/:token_hash", requireRole("teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const parsed = zDeviceTokenHash.safeParse(c.req.param("token_hash"));
  if (!parsed.success) fail("NOT_FOUND");
  const removed = await actorTx(c, async (tx) => {
    const n = await tx.exec(sql`DELETE FROM app.device_tokens WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND token_hash = ${parsed.data}`);
    if (n > 0) {
      await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
        VALUES (${actor.orgId}, ${actor.userId}, 'device.unregistered', ${actor.userId}, ${json({ count: n })}::jsonb)`);
    }
    return n;
  });
  return action(c, { removed });
});
