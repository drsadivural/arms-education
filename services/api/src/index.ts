import type { Bindings } from "./env";
import { createApp } from "./app";
import { workerDeps } from "./deps";
import { runScheduled } from "./jobs";
import { handleNotificationBatch } from "./jobs/queue";

const app = createApp(workerDeps);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(workerDeps(env)));
  },
  async queue(batch: MessageBatch<unknown>, env: Bindings) {
    await handleNotificationBatch(workerDeps(env), batch.messages);
  },
} satisfies ExportedHandler<Bindings>;
