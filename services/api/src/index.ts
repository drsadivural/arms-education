import { ConfigError, type Bindings } from "./env";
import { createApp } from "./app";
import { workerDeps } from "./deps";
import { runScheduled } from "./jobs";
import { handleNotificationBatch } from "./jobs/queue";

const app = createApp(workerDeps);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    let deps;
    try {
      deps = workerDeps(env);
    } catch (err) {
      // Deployed before every secret/binding is registered: there is no database to work on yet.
      if (!(err instanceof ConfigError)) throw err;
      console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "scheduled_skipped_not_configured", detail: err.message }));
      return;
    }
    ctx.waitUntil(runScheduled(deps));
  },
  // A configuration error throws here on purpose: the queue redelivers the messages once the deployment is complete.
  async queue(batch: MessageBatch<unknown>, env: Bindings) {
    await handleNotificationBatch(workerDeps(env), batch.messages);
  },
} satisfies ExportedHandler<Bindings>;
