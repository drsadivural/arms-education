/**
 * External services other than Auth. Each slot is null when its configuration is absent; features that
 * depend on a missing service respond NOT_CONFIGURED (or keep content unpublished) instead of faking success.
 */
import type { Bindings, Config } from "../env";
import { createObjectStorage, type ObjectStorage } from "./storage";

import { createMalwareScanner, type MalwareScanner } from "./scanner";

import { createMailer, type Mailer } from "./mail";

import { createPushSender, type PushSender } from "./push";

import { createNotificationQueue, type NotificationQueue } from "./queue";

import { createRealtimeProvider, type RealtimeProvider } from "./realtime";

export interface Integrations {
  storage: ObjectStorage | null;

  scanner: MalwareScanner | null;

  mail: Mailer | null;

  push: PushSender | null;

  queue: NotificationQueue | null;

  realtime: RealtimeProvider | null;
}

export function createIntegrations(env: Bindings, config: Config): Integrations {
  return {
    storage: createObjectStorage(env, config),

    scanner: createMalwareScanner(env, config),

    mail: createMailer(env, config),

    push: createPushSender(env, config),

    queue: createNotificationQueue(env, config),

    realtime: createRealtimeProvider(env, config),
  };
}
