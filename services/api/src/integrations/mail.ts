/** Transactional e-mail provider for application notifications (owned by the notifications module). */
import type { Bindings, Config } from "../env";

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

export function createMailer(_env: Bindings, _config: Config): Mailer | null {
  return null;
}
