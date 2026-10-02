/**
 * Test-only Auth provider and token issuer. Tokens are real ES256 JWTs verified by the production
 * JwtVerifier against a local JWKS, so signature/issuer/audience/expiry checks are exercised.
 */
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { ApiError } from "../../src/http/errors";
import type { AuthProvider, ProviderSession, TotpEnrollment } from "../../src/integrations/supabase-auth";

export const TEST_ISSUER = "https://auth.test.invalid/auth/v1";
export const TEST_AUDIENCE = "authenticated";
export const TEST_TOTP_CODE = "246810";

const keyPair = await generateKeyPair("ES256", { extractable: true });
const publicJwk: JWK = { ...(await exportJWK(keyPair.publicKey)), kid: "test-key-1", alg: "ES256", use: "sig" };
export const testKeySet = createLocalJWKSet({ keys: [publicJwk] });

/** A second key that is NOT in the JWKS — used to prove forged tokens are rejected. */
const foreignKey = await generateKeyPair("ES256", { extractable: true });

export async function issueToken(
  userId: string,
  opts: { aal?: "aal1" | "aal2"; expiresInSeconds?: number; email?: string; issuer?: string; audience?: string; forged?: boolean } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: "authenticated", aal: opts.aal ?? "aal1", session_id: crypto.randomUUID(), email: opts.email })
    .setProtectedHeader({ alg: "ES256", kid: "test-key-1" })
    .setSubject(userId)
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(opts.audience ?? TEST_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expiresInSeconds ?? 3600))
    .sign(opts.forged ? foreignKey.privateKey : keyPair.privateKey);
}

interface TestUser {
  userId: string;
  email: string;
  password: string;
  banned: boolean;
  factors: { id: string; status: "verified" | "unverified" }[];
}

export class TestAuthProvider implements AuthProvider {
  readonly users = new Map<string, TestUser>();
  private readonly refreshTokens = new Map<string, { userId: string; aal: "aal1" | "aal2" }>();
  readonly invitesSent: { email: string; metadata: Record<string, unknown> }[] = [];
  readonly passwordResets: string[] = [];
  failNextInvite = false;
  accessTtlSeconds = 3600;

  register(email: string, password: string, userId: string): void {
    this.users.set(email.toLowerCase(), { userId, email, password, banned: false, factors: [] });
  }

  private byId(userId: string): TestUser | undefined {
    return [...this.users.values()].find((u) => u.userId === userId);
  }

  private async session(userId: string, aal: "aal1" | "aal2"): Promise<ProviderSession> {
    const refreshToken = crypto.randomUUID();
    this.refreshTokens.set(refreshToken, { userId, aal });
    return {
      accessToken: await issueToken(userId, { aal, expiresInSeconds: this.accessTtlSeconds }),
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + this.accessTtlSeconds,
      userId,
    };
  }

  private async userFromAccessToken(accessToken: string): Promise<TestUser> {
    const [, payload] = accessToken.split(".");
    const sub = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()).sub as string;
    const u = this.byId(sub);
    if (!u) throw new ApiError("SESSION_EXPIRED");
    return u;
  }

  async signInWithPassword(email: string, password: string) {
    const u = this.users.get(email.toLowerCase());
    if (!u || u.password !== password) throw new ApiError("INVALID_CREDENTIALS");
    if (u.banned) throw new ApiError("ACCOUNT_DISABLED");
    return this.session(u.userId, "aal1");
  }

  async refresh(refreshToken: string) {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry) throw new ApiError("SESSION_EXPIRED");
    this.refreshTokens.delete(refreshToken);
    return this.session(entry.userId, entry.aal);
  }

  async signOut() {}

  async sendPasswordReset(email: string) {
    this.passwordResets.push(email);
  }

  async listTotpFactors(accessToken: string) {
    return (await this.userFromAccessToken(accessToken)).factors;
  }

  async enrollTotp(accessToken: string): Promise<TotpEnrollment> {
    const u = await this.userFromAccessToken(accessToken);
    const id = crypto.randomUUID();
    u.factors.push({ id, status: "unverified" });
    return { factorId: id, qrCode: "data:image/svg+xml;utf-8,<svg/>", uri: `otpauth://totp/ARMS:${u.email}?secret=TEST` };
  }

  async verifyTotp(accessToken: string, factorId: string, code: string) {
    const u = await this.userFromAccessToken(accessToken);
    const f = u.factors.find((x) => x.id === factorId);
    if (!f || code !== TEST_TOTP_CODE) {
      throw new ApiError("VALIDATION_FAILED", { field_errors: { code: "認証コードが正しくありません。" } });
    }
    f.status = "verified";
    return this.session(u.userId, "aal2");
  }

  async adminCreateUser(email: string) {
    const existing = this.users.get(email.toLowerCase());
    if (existing) throw new ApiError("EMAIL_TAKEN");
    const userId = crypto.randomUUID();
    this.register(email, crypto.randomUUID(), userId);
    return { userId };
  }

  async adminSendInvite(email: string, metadata: Record<string, unknown>) {
    if (this.failNextInvite) {
      this.failNextInvite = false;
      throw new ApiError("AUTH_PROVIDER_UNAVAILABLE");
    }
    const u = this.users.get(email.toLowerCase());
    if (!u) throw new ApiError("AUTH_PROVIDER_UNAVAILABLE");
    this.invitesSent.push({ email, metadata });
    return { userId: u.userId };
  }

  readonly passwordUpdates: { userId: string; password: string }[] = [];
  async updatePassword(accessToken: string, password: string) {
    const u = await this.userFromAccessToken(accessToken);
    if (password === u.password) throw new ApiError("VALIDATION_FAILED", { field_errors: { password: "以前と異なるパスワードを入力してください。" } });
    u.password = password;
    this.passwordUpdates.push({ userId: u.userId, password });
  }

  async adminSetBanned(userId: string, banned: boolean) {
    const u = this.byId(userId);
    if (u) u.banned = banned;
  }
}
