/**
 * Apple Push Notification service sender (owned by the notifications module).
 *
 * APNs provider API with token-based authentication
 * (https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns):
 *   POST https://api.push.apple.com/3/device/<token>   (api.sandbox.push.apple.com for development builds)
 *   authorization: bearer <ES256 JWT {iss: team id, iat} with kid = key id, signed by the .p8 key>
 *   apns-topic: <bundle id>, apns-push-type: alert, apns-priority: 10, apns-collapse-id, apns-expiration
 * The provider JWT is cached for at most 50 minutes (Apple accepts 20–60 minutes; refreshing more often than
 * every 20 minutes is throttled). APNs requires HTTP/2 — Workers outbound `fetch` negotiation of HTTP/2 with
 * api.push.apple.com must be verified on a real deployment (see report).
 *
 * Device tokens are stored AES-256-GCM encrypted (DEVICE_TOKEN_ENCRYPTION_KEY) and identified by
 * sha256(token); sealing/opening lives here so the dispatcher and the /devices route share one key source.
 */
import type { Bindings, Config } from "../env";
import { ConfigError } from "../env";
import { base64UrlDecode, base64UrlEncode, decryptString, encryptString } from "../auth/crypto";

export interface PushPayload {
  title: string;
  body: string;
  deepLink: string;
  collapseId?: string;
}

/** sent; invalid_token (unregistered/bad token → delete the device); retry (transient); failed (permanent rejection). */
export type PushResult = "sent" | "invalid_token" | "retry" | "failed";

export interface PushSender {
  send(deviceToken: string, environment: "sandbox" | "production", payload: PushPayload): Promise<PushResult>;
  /** Encrypts a device token for storage; `aad` binds the ciphertext to its owner row. */
  sealToken(token: string, aad: string): Promise<string>;
  openToken(sealed: string, aad: string): Promise<string>;
}

export interface DeviceTokenCipher {
  seal(token: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/** AES-256-GCM device-token cipher (key: 32 bytes, base64/base64url). */
export function createDeviceTokenCipher(base64Key: string): DeviceTokenCipher {
  let length = -1;
  try {
    length = base64UrlDecode(base64Key).length;
  } catch {
    length = -1;
  }
  if (length !== 32) throw new ConfigError("DEVICE_TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)");
  return {
    seal: (token, aad) => encryptString(base64Key, token, aad),
    open: (sealed, aad) => decryptString(base64Key, sealed, aad),
  };
}

export interface ApnsOptions {
  keyId: string;
  teamId: string;
  /** Contents of the AuthKey_XXXX.p8 file (PKCS#8 PEM). Literal "\n" sequences are accepted. */
  privateKeyPem: string;
  /** apns-topic: the iOS bundle id. */
  topic: string;
  tokenKey: string;
  /** Override host for both environments (e.g. a relay); default per device environment. */
  host?: string;
  fetch?: typeof fetch;
  /** Epoch milliseconds (tests). */
  now?: () => number;
  timeoutMs?: number;
}

const TOKEN_TTL_SECONDS = 50 * 60;
const MAX_PAYLOAD_BYTES = 4096;
const enc = new TextEncoder();

export function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 64) throw new ConfigError("APNS_PRIVATE_KEY is not a PEM encoded PKCS#8 key");
  return base64UrlDecode(body);
}

/** Builds the APNs JSON payload, shortening the body so the payload stays within 4 KB. */
export function apnsPayload(p: PushPayload): string {
  let body = p.body;
  for (;;) {
    const json = JSON.stringify({ aps: { alert: { title: p.title, body }, sound: "default" }, deep_link: p.deepLink });
    if (enc.encode(json).length <= MAX_PAYLOAD_BYTES || body.length === 0) return json;
    body = `${body.slice(0, Math.max(0, Math.floor(body.length * 0.8) - 1))}…`;
  }
}

export function createApnsSender(opts: ApnsOptions): PushSender {
  const doFetch = opts.fetch ?? fetch;
  const clock = opts.now ?? (() => Date.now());
  const cipher = createDeviceTokenCipher(opts.tokenKey);
  const der = pemToPkcs8(opts.privateKeyPem);
  let keyPromise: Promise<CryptoKey> | null = null;
  let cached: { jwt: string; iat: number } | null = null;

  const signingKey = () =>
    (keyPromise ??= crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]).catch((e) => {
      keyPromise = null;
      throw e;
    }));

  async function providerToken(): Promise<string> {
    const nowSec = Math.floor(clock() / 1000);
    if (cached && nowSec - cached.iat < TOKEN_TTL_SECONDS) return cached.jwt;
    const header = base64UrlEncode(enc.encode(JSON.stringify({ alg: "ES256", kid: opts.keyId })));
    const claims = base64UrlEncode(enc.encode(JSON.stringify({ iss: opts.teamId, iat: nowSec })));
    const input = `${header}.${claims}`;
    // WebCrypto ECDSA signatures are IEEE P1363 (r||s), exactly what JWS ES256 requires.
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(), enc.encode(input));
    cached = { jwt: `${input}.${base64UrlEncode(new Uint8Array(sig))}`, iat: nowSec };
    return cached.jwt;
  }

  async function post(deviceToken: string, environment: "sandbox" | "production", payload: PushPayload) {
    const host = opts.host ?? (environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com");
    const headers: Record<string, string> = {
      authorization: `bearer ${await providerToken()}`,
      "apns-topic": opts.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(clock() / 1000) + 24 * 60 * 60),
      "content-type": "application/json",
    };
    if (payload.collapseId) headers["apns-collapse-id"] = payload.collapseId.slice(0, 64);
    return doFetch(`https://${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers,
      body: apnsPayload(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  }

  return {
    sealToken: (token, aad) => cipher.seal(token, aad),
    openToken: (sealed, aad) => cipher.open(sealed, aad),
    async send(deviceToken, environment, payload) {
      if (!/^[0-9a-fA-F]{32,200}$/.test(deviceToken)) return "invalid_token";
      for (let attempt = 0; attempt < 2; attempt++) {
        let res: Response;
        try {
          res = await post(deviceToken.toLowerCase(), environment, payload);
        } catch {
          return "retry";
        }
        if (res.status === 200) {
          await res.body?.cancel().catch(() => undefined);
          return "sent";
        }
        const reason = ((await res.json().catch(() => null)) as { reason?: string } | null)?.reason ?? "";
        if (res.status === 410) return "invalid_token";
        if (res.status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) return "invalid_token";
        if (res.status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
          cached = null;
          if (attempt === 0) continue;
          return "retry";
        }
        if (res.status === 429 || res.status >= 500) return "retry";
        return "failed";
      }
      return "retry";
    },
  };
}

export function createPushSender(env: Bindings, _config: Config): PushSender | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const privateKeyPem = env.APNS_PRIVATE_KEY;
  const topic = env.IOS_BUNDLE_ID?.trim();
  const tokenKey = env.DEVICE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!keyId || !teamId || !privateKeyPem || !topic || !tokenKey) return null;
  const host = env.APNS_HOST?.trim() || undefined;
  if (host && !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new ConfigError("APNS_HOST is invalid");
  return createApnsSender({ keyId, teamId, privateKeyPem, topic, tokenKey, host });
}
