import type { Deps } from "../context";

/** Notification queue consumer: each message points at an outbox row to dispatch. */
export async function handleNotificationBatch(_deps: Deps, _messages: readonly { body: unknown; ack(): void; retry(): void }[]): Promise<void> {}
