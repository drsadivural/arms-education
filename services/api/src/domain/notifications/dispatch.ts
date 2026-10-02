/**
 * Outbox dispatcher (transactional outbox → in-app notifications → e-mail / APNs).
 *
 * Claim: a row is processed only by whoever moves it to 'processing' (pending & due, or processing whose
 * lock expired) — `FOR UPDATE SKIP LOCKED` for batches, a guarded UPDATE for single queue messages.
 * Notifications: one app.notifications row per (org, user, event) — re-processing never duplicates.
 * External deliveries: one app.notification_deliveries row per (notification, channel, target); a final row
 * (sent / failed / skipped / invalid_token) is never attempted again, and providers receive a stable
 * idempotency key (e-mail) / collapse id (APNs) in case a crash happened between sending and recording.
 * Failures: transient delivery failures put the outbox row back to 'pending' with exponential backoff +
 * jitter; after OUTBOX_MAX_ATTEMPTS it becomes 'failed'. last_error stores an error code only.
 * Business data is never touched here, so a notification failure cannot roll back a reservation change.
 */
import type { Deps } from "../../context";
import { RequestDb } from "../../db/client";
import { sql } from "../../db/sql";
import { MailDeliveryError } from "../../integrations/mail";
import { deviceTokenAad } from "./devices";
import { NOTIFICATION_RULES, type NotificationDraft, type OutboxEvent } from "./rules";

export const OUTBOX_MAX_ATTEMPTS = 10;
export const OUTBOX_LOCK_SECONDS = 300;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 60 * 60;

/** Exponential backoff with ±20% jitter: 30s, 60s, 120s, … capped at 1 hour. */
export function backoffSeconds(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1));
  return Math.max(1, Math.round(base * (0.8 + random() * 0.4)));
}

const CLAIM_COLUMNS = sql`id, event_type, entity_id, payload, attempts`;

/** Claims one outbox row (queue message path). Null when it is not due, already done or claimed elsewhere. */
export async function claimOutboxRow(db: RequestDb, orgId: string, outboxId: string): Promise<OutboxEvent | null> {
  return db.tx({ orgId }, (tx) =>
    tx.maybeOne<OutboxEvent>(sql`
      UPDATE app.outbox SET state = 'processing', attempts = attempts + 1, locked_until = now() + make_interval(secs => ${OUTBOX_LOCK_SECONDS})
      WHERE org_id = ${orgId} AND id = ${outboxId}
        AND ((state = 'pending' AND next_attempt_at <= now()) OR (state = 'processing' AND locked_until < now()))
      RETURNING ${CLAIM_COLUMNS}`),
  );
}

/** Claims up to `limit` due outbox rows of the organisation (cron fallback path). */
export async function claimDueOutbox(db: RequestDb, orgId: string, limit: number): Promise<OutboxEvent[]> {
  return db.tx({ orgId }, (tx) =>
    tx.query<OutboxEvent>(sql`
      WITH due AS (
        SELECT id FROM app.outbox
        WHERE org_id = ${orgId}
          AND ((state = 'pending' AND next_attempt_at <= now()) OR (state = 'processing' AND locked_until < now()))
        ORDER BY next_attempt_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE app.outbox o SET state = 'processing', attempts = o.attempts + 1, locked_until = now() + make_interval(secs => ${OUTBOX_LOCK_SECONDS})
      FROM due WHERE o.org_id = ${orgId} AND o.id = due.id
      RETURNING o.id, o.event_type, o.entity_id, o.payload, o.attempts`),
  );
}

interface NotificationTarget {
  id: string;
  user_id: string;
  title: string;
  body: string;
  deep_link: string;
  email: string | null;
  enabled: boolean;
}

type DeliveryOutcome =
  | { state: "sent"; providerMessageId?: string | null }
  | { state: "pending" | "failed" | "skipped" | "invalid_token"; code: string; tried: boolean };

/**
 * Runs one external delivery at most once to a final state. Returns the retry code when the attempt failed
 * transiently (the outbox row must be retried), null otherwise.
 */
async function withDelivery(
  db: RequestDb,
  orgId: string,
  notificationId: string,
  channel: "email" | "push",
  target: string,
  attempt: () => Promise<DeliveryOutcome>,
): Promise<string | null> {
  const current = await db.tx({ orgId }, async (tx) => {
    await tx.exec(sql`
      INSERT INTO app.notification_deliveries(org_id, notification_id, channel, target, state)
      VALUES (${orgId}, ${notificationId}, ${channel}, ${target}, 'pending') ON CONFLICT DO NOTHING`);
    return tx.one<{ state: string }>(sql`
      SELECT state FROM app.notification_deliveries
      WHERE org_id = ${orgId} AND notification_id = ${notificationId} AND channel = ${channel} AND target = ${target}`);
  });
  if (current.state !== "pending") return null;
  const outcome = await attempt();
  const code = outcome.state === "sent" ? null : outcome.code;
  const tried = outcome.state === "sent" || outcome.tried;
  const providerId = outcome.state === "sent" ? (outcome.providerMessageId ?? null) : null;
  await db.tx({ orgId }, (tx) =>
    tx.exec(sql`
      UPDATE app.notification_deliveries SET state = ${outcome.state}, attempts = attempts + ${tried ? 1 : 0}, last_error = ${code},
        provider_message_id = coalesce(${providerId}, provider_message_id),
        sent_at = CASE WHEN ${outcome.state} = 'sent' THEN now() ELSE NULL END, updated_at = now()
      WHERE org_id = ${orgId} AND notification_id = ${notificationId} AND channel = ${channel} AND target = ${target} AND state = 'pending'`),
  );
  return outcome.state === "pending" ? code : null;
}

export function emailText(n: { body: string }): string {
  return [
    n.body,
    "",
    "詳細はARMSアプリの「お知らせ」またはWeb管理画面でご確認ください。",
    "",
    "―",
    "このメールはARMS（新入社員研修システム）から自動送信されています。",
    "通知の受け取りはアプリの設定から変更できます。",
  ].join("\n");
}

async function deliverEmail(deps: Deps, db: RequestDb, orgId: string, n: NotificationTarget, skip: string | null): Promise<string | null> {
  return withDelivery(db, orgId, n.id, "email", "email", async () => {
    if (skip) return { state: "skipped", code: skip, tried: false };
    const mailer = deps.integrations.mail;
    if (!mailer) return { state: "skipped", code: "NOT_CONFIGURED", tried: false };
    if (!n.email) return { state: "skipped", code: "NO_ADDRESS", tried: false };
    try {
      const res = await mailer.send({ to: n.email, subject: `【ARMS】${n.title}`, text: emailText(n), idempotencyKey: `arms-notification-${n.id}-email` });
      return { state: "sent", providerMessageId: res.providerMessageId };
    } catch (e) {
      if (e instanceof MailDeliveryError) return { state: e.retryable ? "pending" : "failed", code: e.code, tried: true };
      return { state: "pending", code: "MAIL_PROVIDER_UNAVAILABLE", tried: true };
    }
  });
}

async function deliverPush(deps: Deps, db: RequestDb, orgId: string, n: NotificationTarget, skip: string | null): Promise<string | null> {
  const devices = await db.tx({ orgId }, (tx) =>
    tx.query<{ token_hash: string; encrypted_token: string; environment: "sandbox" | "production" }>(sql`
      SELECT token_hash, encrypted_token, environment FROM app.device_tokens WHERE org_id = ${orgId} AND user_id = ${n.user_id} ORDER BY token_hash`),
  );
  let retry: string | null = null;
  for (const d of devices) {
    const removeDevice = () =>
      db.tx({ orgId }, (tx) => tx.exec(sql`DELETE FROM app.device_tokens WHERE org_id = ${orgId} AND user_id = ${n.user_id} AND token_hash = ${d.token_hash}`));
    const code = await withDelivery(db, orgId, n.id, "push", d.token_hash, async () => {
      if (skip) return { state: "skipped", code: skip, tried: false };
      const push = deps.integrations.push;
      if (!push) return { state: "skipped", code: "NOT_CONFIGURED", tried: false };
      let token: string;
      try {
        token = await push.openToken(d.encrypted_token, deviceTokenAad(orgId, n.user_id, d.token_hash));
      } catch {
        await removeDevice();
        return { state: "failed", code: "TOKEN_UNREADABLE", tried: false };
      }
      const result = await push.send(token, d.environment, { title: n.title, body: n.body, deepLink: n.deep_link, collapseId: n.id });
      switch (result) {
        case "sent":
          return { state: "sent" };
        case "invalid_token":
          await removeDevice();
          return { state: "invalid_token", code: "APNS_INVALID_TOKEN", tried: true };
        case "failed":
          return { state: "failed", code: "APNS_REJECTED", tried: true };
        default:
          return { state: "pending", code: "APNS_RETRY", tried: true };
      }
    });
    retry = code ?? retry;
  }
  return retry;
}

export type DispatchOutcome = "delivered" | "retry" | "failed";

async function finalize(db: RequestDb, orgId: string, row: OutboxEvent, retryCode: string | null, note: string | null): Promise<DispatchOutcome> {
  if (retryCode === null) {
    await db.tx({ orgId }, (tx) =>
      tx.exec(sql`UPDATE app.outbox SET state = 'delivered', delivered_at = now(), locked_until = NULL, last_error = ${note}
        WHERE org_id = ${orgId} AND id = ${row.id}`),
    );
    return "delivered";
  }
  if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
    await db.tx({ orgId }, (tx) =>
      tx.exec(sql`UPDATE app.outbox SET state = 'failed', locked_until = NULL, last_error = ${retryCode} WHERE org_id = ${orgId} AND id = ${row.id}`),
    );
    return "failed";
  }
  const delay = backoffSeconds(row.attempts);
  await db.tx({ orgId }, (tx) =>
    tx.exec(sql`UPDATE app.outbox SET state = 'pending', locked_until = NULL, last_error = ${retryCode},
      next_attempt_at = now() + make_interval(secs => ${delay}) WHERE org_id = ${orgId} AND id = ${row.id}`),
  );
  return "retry";
}

/** Processes one claimed outbox row. Never throws for delivery problems; the row is rescheduled instead. */
export async function processOutboxRow(deps: Deps, db: RequestDb, orgId: string, row: OutboxEvent): Promise<DispatchOutcome> {
  try {
    const prepared = await db.tx({ orgId }, async (tx) => {
      const org = await tx.one<{ timezone: string; settings: Record<string, unknown> | null }>(sql`
        SELECT timezone, settings FROM app.organizations WHERE id = ${orgId}`);
      const rule = NOTIFICATION_RULES[row.event_type];
      if (!rule) return { noRule: true, orgEnabled: true, notifications: [] as NotificationTarget[] };
      const drafts = await rule({ tx, orgId, timezone: org.timezone, event: row });
      const byUser = new Map<string, NotificationDraft>();
      for (const d of drafts) if (!byUser.has(d.userId)) byUser.set(d.userId, d);
      for (const d of byUser.values()) {
        await tx.exec(sql`
          INSERT INTO app.notifications(org_id, user_id, event_id, title, body, deep_link)
          SELECT ${orgId}, ${d.userId}, ${row.id}, ${d.title}, ${d.body}, ${d.deepLink}
          WHERE EXISTS (SELECT 1 FROM app.memberships m WHERE m.org_id = ${orgId} AND m.id = ${d.userId} AND m.active)
          ON CONFLICT (org_id, user_id, event_id) DO NOTHING`);
      }
      const notifications = await tx.query<NotificationTarget>(sql`
        SELECT n.id, n.user_id, n.title, n.body, n.deep_link, u.email, coalesce(p.notifications_enabled, true) AS enabled
        FROM app.notifications n
        JOIN app.users u ON u.id = n.user_id
        LEFT JOIN app.user_preferences p ON p.org_id = n.org_id AND p.user_id = n.user_id
        WHERE n.org_id = ${orgId} AND n.event_id = ${row.id}
        ORDER BY n.id`);
      return { noRule: false, orgEnabled: org.settings?.notifications_enabled !== false, notifications };
    });

    let retryCode: string | null = null;
    for (const n of prepared.notifications) {
      // The in-app notification above is always kept; e-mail / APNs honour the organisation and user settings.
      const skip = !prepared.orgEnabled ? "ORG_DISABLED" : !n.enabled ? "OPTED_OUT" : null;
      const emailRetry = await deliverEmail(deps, db, orgId, n, skip);
      const pushRetry = await deliverPush(deps, db, orgId, n, skip);
      retryCode = emailRetry ?? pushRetry ?? retryCode;
    }
    return await finalize(db, orgId, row, retryCode, prepared.noRule ? "NO_NOTIFICATION_RULE" : null);
  } catch (e) {
    const err = e as { name?: string; code?: string };
    deps.log({ level: "error", msg: "outbox_dispatch_failed", org_id: orgId, outbox_id: row.id, event_type: row.event_type, error_name: err?.name, error_code: err?.code });
    try {
      return await finalize(db, orgId, row, "DISPATCH_ERROR", null);
    } catch {
      // The claim lock expires and the cron reclaims the row.
      return "retry";
    }
  }
}

/** Queue consumer path: claim the referenced row (if still due) and process it. */
export async function dispatchOutboxMessage(deps: Deps, orgId: string, outboxId: string): Promise<DispatchOutcome | "skipped"> {
  const db = new RequestDb(deps.connections);
  try {
    const row = await claimOutboxRow(db, orgId, outboxId);
    if (!row) return "skipped";
    return await processOutboxRow(deps, db, orgId, row);
  } finally {
    await db.close();
  }
}

/** Cron fallback path: claim and process due rows of one organisation. Returns the number processed. */
export async function dispatchDueOutbox(deps: Deps, orgId: string, limit = 50): Promise<number> {
  const db = new RequestDb(deps.connections);
  try {
    const rows = await claimDueOutbox(db, orgId, limit);
    for (const row of rows) await processOutboxRow(deps, db, orgId, row);
    return rows.length;
  } finally {
    await db.close();
  }
}
