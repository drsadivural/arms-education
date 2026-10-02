/**
 * Cloudflare Queue producer that wakes the outbox dispatcher (owned by the notifications module).
 * Messages only carry identifiers ({org_id, outbox_id}); the consumer re-reads the outbox row, so a lost or
 * duplicated message is harmless — the cron fallback dispatches anything still due.
 */
import type { Bindings, Config } from "../env";

export interface OutboxMessage {
  org_id: string;
  outbox_id: string;
}

export interface NotificationQueue {
  enqueue(message: OutboxMessage): Promise<void>;
  enqueueBatch(messages: readonly OutboxMessage[]): Promise<void>;
}

/** Cloudflare Queues accept at most 100 messages per sendBatch call. */
const MAX_BATCH = 100;

export function createCloudflareQueue(queue: Queue<OutboxMessage>): NotificationQueue {
  return {
    async enqueue(message) {
      await queue.send(message, { contentType: "json" });
    },
    async enqueueBatch(messages) {
      for (let i = 0; i < messages.length; i += MAX_BATCH) {
        const chunk = messages.slice(i, i + MAX_BATCH);
        await queue.sendBatch(chunk.map((body) => ({ body, contentType: "json" as const })));
      }
    },
  };
}

export function createNotificationQueue(env: Bindings, _config: Config): NotificationQueue | null {
  return env.NOTIFICATION_QUEUE ? createCloudflareQueue(env.NOTIFICATION_QUEUE as Queue<OutboxMessage>) : null;
}
