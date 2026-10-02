/** OpenAI Realtime client-secret minting (owned by the voice module). The permanent key never leaves the Worker. */
import type { Bindings, Config } from "../env";

export interface RealtimeClientSecret {
  value: string;
  expiresAt: Date;
  providerSessionId: string | null;
}

export interface RealtimeProvider {
  createClientSecret(input: { instructions: string; tools: unknown[]; expiresAfterSeconds: number; safetyIdentifier: string }): Promise<RealtimeClientSecret>;
}

export function createRealtimeProvider(_env: Bindings, _config: Config): RealtimeProvider | null {
  return null;
}
