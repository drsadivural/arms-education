/** Apple Push Notification service sender (owned by the notifications module). */
import type { Bindings, Config } from "../env";

export interface PushPayload {
  title: string;
  body: string;
  deepLink: string;
  collapseId?: string;
}

export type PushResult = "sent" | "invalid_token" | "retry";

export interface PushSender {
  send(deviceToken: string, environment: "sandbox" | "production", payload: PushPayload): Promise<PushResult>;
}

export function createPushSender(_env: Bindings, _config: Config): PushSender | null {
  return null;
}
