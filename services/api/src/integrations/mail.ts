/**
 * Transactional e-mail provider for application notifications (owned by the notifications module).
 *
 * Provider: any service exposing the Resend-compatible HTTP API (https://resend.com/docs/api-reference/emails/send-email):
 *   POST {MAIL_PROVIDER_URL}/emails
 *   Authorization: Bearer {MAIL_PROVIDER_API_KEY}
 *   Idempotency-Key: <stable per notification+channel>   (provider de-duplicates retries for 24h)
 *   {"from": MAIL_FROM, "to": ["…"], "subject": "…", "text": "…"} → 200 {"id": "…"}
 * Resend was chosen because it is a plain HTTPS JSON API callable from Workers `fetch` (no SMTP sockets) and
 * supports request idempotency keys. MAIL_PROVIDER_URL is e.g. `https://api.resend.com`.
 * When any of the three settings is missing the slot is null and e-mail deliveries are recorded as skipped
 * (NOT_CONFIGURED) — never reported as sent.
 */
import type { Bindings, Config } from "../env";
import { ConfigError } from "../env";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Provider-side idempotency key so outbox retries never send a duplicate. */
  idempotencyKey: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ providerMessageId: string | null }>;
}

export type MailErrorCode = "MAIL_RATE_LIMITED" | "MAIL_PROVIDER_UNAVAILABLE" | "MAIL_AUTH_FAILED" | "MAIL_REJECTED";

/** A delivery failure. `retryable=false` means retrying the same message cannot succeed (e.g. invalid address). */
export class MailDeliveryError extends Error {
  constructor(
    readonly code: MailErrorCode,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(code);
    this.name = "MailDeliveryError";
  }
}

export interface HttpMailerOptions {
  baseUrl: string;
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_SUBJECT = 200;
const MAX_TEXT = 20_000;

/** Resend-compatible HTTP mailer. */
export function createHttpMailer(opts: HttpMailerOptions): Mailer {
  const doFetch = opts.fetch ?? fetch;
  const endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/emails`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async send(message) {
      if (!message.to || /[\r\n]/.test(message.to) || /[\r\n]/.test(message.subject)) throw new MailDeliveryError("MAIL_REJECTED", false);
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify({
            from: opts.from,
            to: [message.to],
            subject: message.subject.slice(0, MAX_SUBJECT),
            text: message.text.slice(0, MAX_TEXT),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new MailDeliveryError("MAIL_PROVIDER_UNAVAILABLE", true);
      }
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
        return { providerMessageId: typeof body?.id === "string" ? body.id.slice(0, 200) : null };
      }
      // Drain the body without reading it into logs (it may echo the recipient address).
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 429) throw new MailDeliveryError("MAIL_RATE_LIMITED", true, res.status);
      if (res.status === 401 || res.status === 403) throw new MailDeliveryError("MAIL_AUTH_FAILED", true, res.status);
      // 409: concurrent request with the same idempotency key is still in progress at the provider.
      if (res.status === 409 || res.status === 408 || res.status >= 500) throw new MailDeliveryError("MAIL_PROVIDER_UNAVAILABLE", true, res.status);
      throw new MailDeliveryError("MAIL_REJECTED", false, res.status);
    },
  };
}

export function createMailer(env: Bindings, config: Config): Mailer | null {
  const url = env.MAIL_PROVIDER_URL?.trim();
  const apiKey = env.MAIL_PROVIDER_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!url || !apiKey || !from) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError("MAIL_PROVIDER_URL is invalid");
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && (config.env === "development" || config.env === "test"))) {
    throw new ConfigError("MAIL_PROVIDER_URL must use https");
  }
  return createHttpMailer({ baseUrl: url, apiKey, from });
}
