/** Cloudflare Queue producer that wakes the outbox dispatcher (owned by the notifications module). */
import type { Bindings, Config } from "../env";

export interface NotificationQueue {
  enqueue(message: { org_id: string; outbox_id: string }): Promise<void>;
}

export function createNotificationQueue(_env: Bindings, _config: Config): NotificationQueue | null {
  return null;
}
