import type { Deps } from "../context";
import { dispatchOutboxMessage } from "../domain/notifications/dispatch";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseMessage(body: unknown): { org_id: string; outbox_id: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { org_id, outbox_id } = body as Record<string, unknown>;
  if (typeof org_id !== "string" || typeof outbox_id !== "string" || !UUID_RE.test(org_id) || !UUID_RE.test(outbox_id)) return null;
  return { org_id: org_id.toLowerCase(), outbox_id: outbox_id.toLowerCase() };
}

/**
 * Notification queue consumer: each message points at an outbox row to dispatch. Delivery outcomes
 * (including transient failures) are recorded on the outbox row, which reschedules itself with backoff, so
 * the message is acknowledged; only infrastructure errors (e.g. the database is unreachable) ask the queue
 * to redeliver. Malformed messages are dropped.
 */
export async function handleNotificationBatch(deps: Deps, messages: readonly { body: unknown; ack(): void; retry(): void }[]): Promise<void> {
  for (const message of messages) {
    const parsed = parseMessage(message.body);
    if (!parsed) {
      deps.log({ level: "warn", msg: "notification_message_invalid" });
      message.ack();
      continue;
    }
    try {
      await dispatchOutboxMessage(deps, parsed.org_id, parsed.outbox_id);
      message.ack();
    } catch (e) {
      const err = e as { name?: string; code?: string };
      deps.log({ level: "error", msg: "notification_message_failed", org_id: parsed.org_id, outbox_id: parsed.outbox_id, error_name: err?.name, error_code: err?.code });
      message.retry();
    }
  }
}
