/**
 * Test helpers for ARMS's own authentication (PostgreSQL): real credentials in the test database (scrypt hashes),
 * a capturing mailer whose e-mails carry the real one-time links, and TOTP codes computed from an enrollment URI.
 */
import type pg from "pg";
import { hashPassword } from "../../src/auth/password";
import { hotp, timeStep } from "../../src/auth/totp";
import { MailDeliveryError, type Mailer, type MailMessage } from "../../src/integrations/mail";

/** Captures e-mails; `failNext` makes the next send fail like a provider outage. */
export class TestMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failNext: MailDeliveryError | null = null;

  async send(message: MailMessage) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.sent.push(message);
    return { providerMessageId: `test-${this.sent.length}` };
  }

  /** The one-time link (token + type) of the newest e-mail sent to `to`. */
  lastLink(to: string): { token: string; type: string } | null {
    const message = [...this.sent].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase());
    const m = message ? /\/auth\/callback#token=([^&\s]+)&type=(\w+)/.exec(message.text) : null;
    return m ? { token: decodeURIComponent(m[1] as string), type: m[2] as string } : null;
  }
}

const hashCache = new Map<string, Promise<string>>();
/** scrypt is deliberately slow (~170 ms); tests reuse one hash per distinct password. */
export function testPasswordHash(password: string): Promise<string> {
  let h = hashCache.get(password);
  if (!h) {
    h = hashPassword(password);
    hashCache.set(password, h);
  }
  return h;
}

/** Authentication fixtures for one test context. */
export class TestAuthKit {
  constructor(
    private readonly admin: pg.Pool,
    readonly mailer: TestMailer,
  ) {}

  /** Gives an existing app user a password (as if they had used their invitation link). */
  async register(email: string, password: string, userId: string): Promise<void> {
    void email;
    await this.admin.query(
      `INSERT INTO app.user_credentials(user_id, password_hash, password_changed_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_login_count = 0, locked_until = NULL`,
      [userId, await testPasswordHash(password)],
    );
  }

  /** Invitation e-mails sent so far. */
  get invitesSent(): { email: string }[] {
    return this.mailer.sent.filter((m) => m.subject.includes("ご招待")).map((m) => ({ email: m.to }));
  }

  /** The next invitation/reset e-mail fails with a (retryable) provider outage. */
  set failNextInvite(fail: boolean) {
    this.mailer.failNext = fail ? new MailDeliveryError("MAIL_PROVIDER_UNAVAILABLE", true, 503) : null;
  }

  async userCount(): Promise<number> {
    return Number((await this.admin.query("SELECT count(*)::int AS n FROM app.users")).rows[0].n);
  }

  /** Open (unrevoked, unexpired) iOS sessions of the user. */
  async openBearerSessions(userId: string): Promise<number> {
    return Number(
      (await this.admin.query("SELECT count(*)::int AS n FROM app.bearer_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()", [userId]))
        .rows[0].n,
    );
  }
}

/** Current TOTP code for the secret in an otpauth:// URI (as an authenticator app would show it). */
export async function totpFromUri(uri: string, at = Date.now()): Promise<string> {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("no secret in otpauth URI");
  return hotp(secret, timeStep(at));
}
