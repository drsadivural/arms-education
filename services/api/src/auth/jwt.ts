import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface VerifiedToken {
  userId: string;
  email: string | null;
  /** Authenticator assurance level: aal2 after MFA verification. */
  aal: "aal1" | "aal2";
  sessionId: string | null;
  expiresAt: number;
}

export interface JwtVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export class InvalidTokenError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies Supabase Auth access tokens with the project's asymmetric signing keys (JWKS),
 * checking signature, issuer, audience and expiry. Symmetric (HS256) tokens are rejected.
 */
export function createJwtVerifier(opts: { keySet: JWTVerifyGetKey; issuer: string; audience: string }): JwtVerifier {
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, opts.keySet, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ["ES256", "RS256", "EdDSA"],
          clockTolerance: 5,
        });
        if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) throw new InvalidTokenError("sub");
        // End-user tokens carry role "authenticated" (self-hosted GoTrue may leave it empty); privileged roles such as
        // service_role/anon are never accepted as user credentials.
        if (payload.role !== undefined && payload.role !== "" && payload.role !== "authenticated") throw new InvalidTokenError("role");
        return {
          userId: payload.sub.toLowerCase(),
          email: typeof payload.email === "string" ? payload.email : null,
          aal: payload.aal === "aal2" ? "aal2" : "aal1",
          sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
          expiresAt: typeof payload.exp === "number" ? payload.exp : 0,
        };
      } catch (e) {
        if (e instanceof InvalidTokenError) throw e;
        throw new InvalidTokenError(e instanceof Error ? e.name : "invalid");
      }
    },
  };
}

const remoteSets = new Map<string, JWTVerifyGetKey>();
/** JWKS fetched from the Auth provider and cached per isolate (jose handles key rotation/refresh). */
export function remoteKeySet(authUrl: string): JWTVerifyGetKey {
  const url = `${authUrl}/.well-known/jwks.json`;
  let set = remoteSets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    remoteSets.set(url, set);
  }
  return set;
}
