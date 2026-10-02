import type { Bindings } from "./env";
import { ConfigError, loadConfig } from "./env";
import type { Deps } from "./context";
import { hyperdriveSource } from "./db/client";
import { createIntegrations } from "./integrations";

let cached: { env: Bindings; deps: Deps } | null = null;

/** Builds Worker dependencies once per isolate (config is validated fail-fast here). */
export function workerDeps(env: Bindings): Deps {
  if (cached && cached.env === env) return cached.deps;
  const config = loadConfig(env);
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) throw new ConfigError("HYPERDRIVE binding (or DATABASE_URL for local development) is required");
  const deps: Deps = {
    config,
    connections: hyperdriveSource(connectionString),
    integrations: createIntegrations(env, config),
    now: () => new Date(),
    log: (event) => console.info(JSON.stringify({ ts: new Date().toISOString(), ...event })),
  };
  cached = { env, deps };
  return deps;
}
