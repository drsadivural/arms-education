/**
 * OpenAI Realtime client-secret minting (docs/05). The permanent OPENAI_API_KEY exists only as a Worker secret;
 * clients receive a short-lived `ek_…` secret and connect over WebRTC (POST /v1/realtime/calls) themselves.
 * The secret is never logged, persisted or returned twice.
 */
import type { Bindings, Config } from "../env";
import { ApiError } from "../http/errors";

export interface RealtimeClientSecret {
  value: string;
  expiresAt: Date;
  providerSessionId: string | null;
}

export interface RealtimeSessionRequest {
  instructions: string;
  tools: unknown[];
  /** Lifetime of the client secret (OpenAI accepts 10–7200 s). */
  expiresAfterSeconds: number;
  /** Hashed, stable per-user identifier for OpenAI abuse monitoring (never the raw user id or e-mail). */
  safetyIdentifier: string;
}

export interface RealtimeProvider {
  readonly model: string;
  readonly voice: string;
  createClientSecret(input: RealtimeSessionRequest): Promise<RealtimeClientSecret>;
}

const OPENAI_BASE = "https://api.openai.com/v1";

export function createRealtimeProvider(env: Bindings, config: Config, fetchImpl: typeof fetch = fetch): RealtimeProvider | null {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const { model, voice } = config.voice;
  // Startup availability check (docs/05 「プロジェクトでの利用可否を起動チェック」), cached per isolate.
  let modelCheck: { ok: boolean; at: number } | null = null;

  async function ensureModelAvailable(): Promise<void> {
    if (modelCheck && Date.now() - modelCheck.at < 10 * 60_000) {
      if (!modelCheck.ok) throw new ApiError("VOICE_UNAVAILABLE");
      return;
    }
    let ok = false;
    try {
      const res = await fetchImpl(`${OPENAI_BASE}/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      ok = res.ok;
      // 5xx/429 are transient: do not cache a negative result for them.
      if (!res.ok && (res.status >= 500 || res.status === 429)) {
        throw new ApiError("VOICE_UNAVAILABLE", { details: { provider_status: res.status } });
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("VOICE_UNAVAILABLE", { cause: e });
    }
    modelCheck = { ok, at: Date.now() };
    if (!ok) throw new ApiError("VOICE_UNAVAILABLE", { details: { reason: "model_unavailable" } });
  }

  return {
    model,
    voice,
    async createClientSecret(input) {
      await ensureModelAvailable();
      const body = {
        expires_after: { anchor: "created_at", seconds: Math.max(10, Math.min(7200, Math.floor(input.expiresAfterSeconds))) },
        session: {
          type: "realtime",
          model,
          instructions: input.instructions,
          tools: input.tools,
          tool_choice: "auto",
          max_output_tokens: 1024,
          audio: {
            input: {
              transcription: { model: "gpt-4o-mini-transcribe", language: "ja" },
              turn_detection: { type: "server_vad", silence_duration_ms: 600, create_response: true, interrupt_response: true },
              noise_reduction: { type: "near_field" },
            },
            output: { voice },
          },
        },
      };
      let res: Response;
      try {
        res = await fetchImpl(`${OPENAI_BASE}/realtime/client_secrets`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "OpenAI-Safety-Identifier": input.safetyIdentifier },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new ApiError("VOICE_UNAVAILABLE", { cause: e });
      }
      if (!res.ok) {
        // 429 (rate/budget) and every other provider failure map to the same Japanese fallback message.
        throw new ApiError("VOICE_UNAVAILABLE", { details: { provider_status: res.status } });
      }
      const json = (await res.json()) as { value?: string; expires_at?: number; session?: { id?: string } };
      if (!json.value || typeof json.expires_at !== "number") throw new ApiError("VOICE_UNAVAILABLE", { details: { reason: "malformed_response" } });
      return { value: json.value, expiresAt: new Date(json.expires_at * 1000), providerSessionId: json.session?.id ?? null };
    },
  };
}
