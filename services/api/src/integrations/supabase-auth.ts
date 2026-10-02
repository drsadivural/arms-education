/**
 * Supabase Auth (GoTrue) REST client used by the Workers BFF.
 * - user-facing calls send the publishable key as `apikey`
 * - admin calls (invite, user creation, ban) use SUPABASE_ADMIN_SECRET, which exists only as a Worker secret
 * Provider error bodies are not forwarded to clients; they are mapped to Japanese API errors.
 */
import { ApiError } from "../http/errors";

export interface ProviderSession {
  accessToken: string;
  refreshToken: string;
  /** epoch seconds */
  expiresAt: number;
  userId: string;
}

export interface TotpEnrollment {
  factorId: string;
  qrCode: string;
  uri: string;
}

export interface AuthProvider {
  signInWithPassword(email: string, password: string): Promise<ProviderSession>;
  refresh(refreshToken: string): Promise<ProviderSession>;
  signOut(accessToken: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  /** TOTP factors of the user, oldest first (unverified until the first successful verification). */
  listTotpFactors(accessToken: string): Promise<{ id: string; status: "verified" | "unverified" }[]>;
  enrollTotp(accessToken: string, friendlyName: string): Promise<TotpEnrollment>;
  verifyTotp(accessToken: string, factorId: string, code: string): Promise<ProviderSession>;
  /** Creates (or finds) the auth user without sending e-mail. */
  adminCreateUser(email: string, metadata: Record<string, unknown>): Promise<{ userId: string }>;
  /** Sends the (Japanese-templated) invitation e-mail through the Auth provider's SMTP. */
  adminSendInvite(email: string, metadata: Record<string, unknown>): Promise<{ userId: string }>;
  /** Blocks or unblocks sign-in at the provider (membership.active is still enforced by the API). */
  adminSetBanned(userId: string, banned: boolean): Promise<void>;
}

interface SupabaseAuthOptions {
  authUrl: string;
  publishableKey: string;
  adminSecret: string | null;
  redirectUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: { id?: string };
}

export function createSupabaseAuth(opts: SupabaseAuthOptions): AuthProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function call(path: string, init: { method: string; body?: unknown; bearer?: string; admin?: boolean }): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!opts.authUrl) throw new ApiError("NOT_CONFIGURED");
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (init.admin) {
      if (!opts.adminSecret) throw new ApiError("NOT_CONFIGURED");
      headers.apikey = opts.adminSecret;
      headers.Authorization = `Bearer ${opts.adminSecret}`;
    } else {
      if (opts.publishableKey) headers.apikey = opts.publishableKey;
      if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${opts.authUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ac.signal,
      });
    } catch (e) {
      throw new ApiError("AUTH_PROVIDER_UNAVAILABLE", { cause: e });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    if (res.status === 429) throw new ApiError("RATE_LIMITED");
    if (res.status >= 500) throw new ApiError("AUTH_PROVIDER_UNAVAILABLE", { details: { provider_status: res.status } });
    return { status: res.status, body };
  }

  function toSession(body: TokenResponse): ProviderSession {
    if (!body.access_token || !body.refresh_token || !body.user?.id) throw new ApiError("AUTH_PROVIDER_UNAVAILABLE");
    const expiresAt = body.expires_at ?? Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600);
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt, userId: body.user.id };
  }

  const errorCode = (body: Record<string, unknown>) => String(body.error_code ?? body.code ?? body.error ?? "");

  return {
    async signInWithPassword(email, password) {
      const { status, body } = await call("/token?grant_type=password", { method: "POST", body: { email, password } });
      if (status === 200) return toSession(body as TokenResponse);
      if (errorCode(body) === "user_banned") throw new ApiError("ACCOUNT_DISABLED");
      throw new ApiError("INVALID_CREDENTIALS");
    },
    async refresh(refreshToken) {
      const { status, body } = await call("/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: refreshToken } });
      if (status === 200) return toSession(body as TokenResponse);
      if (errorCode(body) === "user_banned") throw new ApiError("ACCOUNT_DISABLED");
      throw new ApiError("SESSION_EXPIRED");
    },
    async signOut(accessToken) {
      // Best effort: the local session row is revoked regardless of the provider response.
      await call("/logout?scope=local", { method: "POST", bearer: accessToken }).catch(() => undefined);
    },
    async sendPasswordReset(email) {
      await call(`/recover?redirect_to=${encodeURIComponent(opts.redirectUrl)}`, { method: "POST", body: { email } });
      // Unknown addresses are not revealed (anti-enumeration); provider outages (5xx/429) were already raised by call().
    },
    async listTotpFactors(accessToken) {
      const { status, body } = await call("/user", { method: "GET", bearer: accessToken });
      if (status !== 200) throw new ApiError("SESSION_EXPIRED");
      const factors = Array.isArray(body.factors) ? (body.factors as { id: string; status: string; factor_type: string; created_at?: string }[]) : [];
      return factors
        .filter((f) => f.factor_type === "totp")
        .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
        .map((f) => ({ id: f.id, status: f.status === "verified" ? ("verified" as const) : ("unverified" as const) }));
    },
    async enrollTotp(accessToken, friendlyName) {
      const { status, body } = await call("/factors", { method: "POST", bearer: accessToken, body: { factor_type: "totp", friendly_name: friendlyName } });
      if (status !== 200) throw new ApiError("INVALID_STATE", { message_ja: "二段階認証を登録できませんでした。再読み込みしてお試しください。" });
      const totp = (body.totp ?? {}) as { qr_code?: string; uri?: string };
      if (typeof body.id !== "string" || !totp.qr_code || !totp.uri) throw new ApiError("AUTH_PROVIDER_UNAVAILABLE");
      return { factorId: body.id, qrCode: totp.qr_code, uri: totp.uri };
    },
    async verifyTotp(accessToken, factorId, code) {
      const ch = await call(`/factors/${encodeURIComponent(factorId)}/challenge`, { method: "POST", bearer: accessToken, body: {} });
      if (ch.status !== 200 || typeof ch.body.id !== "string") throw new ApiError("INVALID_STATE");
      const { status, body } = await call(`/factors/${encodeURIComponent(factorId)}/verify`, {
        method: "POST",
        bearer: accessToken,
        body: { challenge_id: ch.body.id, code },
      });
      if (status === 200) return toSession(body as TokenResponse);
      throw new ApiError("VALIDATION_FAILED", { message_ja: "認証コードが正しくありません。", field_errors: { code: "認証コードが正しくありません。" } });
    },
    async adminCreateUser(email, metadata) {
      const { status, body } = await call("/admin/users", { method: "POST", admin: true, body: { email, email_confirm: false, user_metadata: metadata } });
      if ((status === 200 || status === 201) && typeof body.id === "string") return { userId: body.id };
      if (status === 422 && /already|exists|registered/i.test(String(body.msg ?? body.message ?? body.error_code ?? ""))) {
        throw new ApiError("EMAIL_TAKEN");
      }
      throw new ApiError("AUTH_PROVIDER_UNAVAILABLE", { details: { provider_status: status } });
    },
    async adminSendInvite(email, metadata) {
      const { status, body } = await call(`/invite?redirect_to=${encodeURIComponent(opts.redirectUrl)}`, { method: "POST", admin: true, body: { email, data: metadata } });
      if ((status === 200 || status === 201) && typeof body.id === "string") return { userId: body.id };
      if (status === 422) throw new ApiError("INVALID_STATE", { message_ja: "このユーザーは既に登録を完了しています。" });
      throw new ApiError("AUTH_PROVIDER_UNAVAILABLE", { details: { provider_status: status } });
    },
    async adminSetBanned(userId, banned) {
      const { status } = await call(`/admin/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        admin: true,
        body: { ban_duration: banned ? "876000h" : "none" },
      });
      if (status !== 200) throw new ApiError("AUTH_PROVIDER_UNAVAILABLE", { details: { provider_status: status } });
    },
  };
}
