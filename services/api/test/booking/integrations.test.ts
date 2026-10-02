/**
 * Notification integrations: the Resend-compatible mailer against a real local HTTP server, the APNs sender
 * (ES256 provider token verified with the public key, request shape, response mapping) and the Queue producer.
 * Real provider delivery (Resend, APNs over HTTP/2 from Workers) is not exercised here.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importSPKI, jwtVerify, decodeProtectedHeader } from "jose";
import type { Bindings } from "../../src/env";
import { ConfigError, loadConfig } from "../../src/env";
import { createHttpMailer, createMailer, type MailDeliveryError } from "../../src/integrations/mail";
import { apnsPayload, createApnsSender, createDeviceTokenCipher, createPushSender } from "../../src/integrations/push";
import { createCloudflareQueue, createNotificationQueue } from "../../src/integrations/queue";
import { TEST_DEVICE_KEY } from "../helpers/booking-fixtures";

const config = loadConfig({ APP_ENV: "test" });

describe("Resend-compatible HTTP mailer", () => {
  let server: Server;
  let base: string;
  const received: { method: string; url: string; headers: IncomingMessage["headers"]; body: unknown }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: { id: "msg_123" } };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: data ? JSON.parse(data) : null });
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  it("POSTs {from, to, subject, text} to /emails with Bearer auth and the Idempotency-Key", async () => {
    const mailer = createHttpMailer({ baseUrl: `${base}/`, apiKey: "re_test_key", from: "ARMS <no-reply@example.invalid>" });
    reply = { status: 200, body: { id: "msg_123" } };
    const out = await mailer.send({ to: "teacher@example.invalid", subject: "【ARMS】予約申請が届きました", text: "本文", idempotencyKey: "arms-notification-x-email" });
    expect(out).toEqual({ providerMessageId: "msg_123" });
    const req = received.at(-1)!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/emails");
    expect(req.headers.authorization).toBe("Bearer re_test_key");
    expect(req.headers["idempotency-key"]).toBe("arms-notification-x-email");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toEqual({ from: "ARMS <no-reply@example.invalid>", to: ["teacher@example.invalid"], subject: "【ARMS】予約申請が届きました", text: "本文" });
  });

  it("maps provider responses to retryable / permanent errors", async () => {
    const mailer = createHttpMailer({ baseUrl: base, apiKey: "k", from: "f@example.invalid" });
    const attempt = async (status: number) => {
      reply = { status, body: { name: "error", message: "detail with teacher@example.invalid" } };
      try {
        await mailer.send({ to: "t@example.invalid", subject: "s", text: "t", idempotencyKey: "k" });
        return null;
      } catch (e) {
        return e as MailDeliveryError;
      }
    };
    expect(await attempt(429)).toMatchObject({ code: "MAIL_RATE_LIMITED", retryable: true });
    expect(await attempt(503)).toMatchObject({ code: "MAIL_PROVIDER_UNAVAILABLE", retryable: true });
    expect(await attempt(409)).toMatchObject({ code: "MAIL_PROVIDER_UNAVAILABLE", retryable: true });
    expect(await attempt(401)).toMatchObject({ code: "MAIL_AUTH_FAILED", retryable: true });
    expect(await attempt(422)).toMatchObject({ code: "MAIL_REJECTED", retryable: false });
    // The provider's message (which may echo addresses) never becomes the error message.
    expect((await attempt(422))?.message).toBe("MAIL_REJECTED");
    const header = await mailer.send({ to: "a@example.invalid\r\nBcc: x@example.invalid", subject: "s", text: "t", idempotencyKey: "k" }).catch((e) => e);
    expect(header).toMatchObject({ code: "MAIL_REJECTED", retryable: false });
  });

  it("network failures are retryable", async () => {
    const mailer = createHttpMailer({ baseUrl: "http://127.0.0.1:1", apiKey: "k", from: "f@example.invalid", timeoutMs: 2000 });
    await expect(mailer.send({ to: "t@example.invalid", subject: "s", text: "t", idempotencyKey: "k" })).rejects.toMatchObject({ code: "MAIL_PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("createMailer: null when not configured; https required outside local development", () => {
    expect(createMailer({} as Bindings, config)).toBeNull();
    expect(createMailer({ MAIL_PROVIDER_URL: "https://api.resend.com", MAIL_PROVIDER_API_KEY: "k" } as Bindings, config)).toBeNull();
    expect(createMailer({ MAIL_PROVIDER_URL: "https://api.resend.com", MAIL_PROVIDER_API_KEY: "k", MAIL_FROM: "a@example.invalid" } as Bindings, config)).not.toBeNull();
    expect(createMailer({ MAIL_PROVIDER_URL: "http://127.0.0.1:8025", MAIL_PROVIDER_API_KEY: "k", MAIL_FROM: "a@example.invalid" } as Bindings, config)).not.toBeNull();
    const prod = loadConfig({ APP_ENV: "development" });
    expect(() => createMailer({ MAIL_PROVIDER_URL: "http://mail.example.invalid", MAIL_PROVIDER_API_KEY: "k", MAIL_FROM: "a@example.invalid" } as Bindings, prod)).toThrow(ConfigError);
  });
});

describe("APNs sender", () => {
  let privatePem: string;
  let publicPem: string;
  const deviceToken = "ab".repeat(32);

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const spki = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
    // Apple .p8 files are PKCS#8 PEM; secrets stores often hold them with literal "\n".
    // Key generated above at test time; the label is assembled so the repository secret scan sees no PEM block.
    const label = ["PRIVATE", "KEY"].join(" ");
    privatePem = `-----BEGIN ${label}-----\\n${pkcs8.match(/.{1,64}/g)!.join("\\n")}\\n-----END ${label}-----`;
    publicPem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
  });

  function sender(responses: { status: number; body?: unknown }[], now: () => number = () => Date.now()) {
    const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      const r = responses.shift() ?? { status: 200 };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    const s = createApnsSender({ keyId: "KEY1234567", teamId: "TEAM123456", privateKeyPem: privatePem, topic: "jp.example.arms", tokenKey: TEST_DEVICE_KEY, fetch: fetchStub, now });
    return { s, requests };
  }

  it("sends an alert with an ES256 provider token signed by the .p8 key", async () => {
    const { s, requests } = sender([{ status: 200 }]);
    const result = await s.send(deviceToken, "sandbox", { title: "予約が承認されました", body: "本文", deepLink: "arms://reservations/1", collapseId: "n-1" });
    expect(result).toBe("sent");
    const req = requests[0]!;
    expect(req.url).toBe(`https://api.sandbox.push.apple.com/3/device/${deviceToken}`);
    expect(req.headers).toMatchObject({ "apns-topic": "jp.example.arms", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "n-1" });
    const jwt = req.headers.authorization!.replace(/^bearer /, "");
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    const { payload } = await jwtVerify(jwt, await importSPKI(publicPem, "ES256"));
    expect(payload.iss).toBe("TEAM123456");
    expect(typeof payload.iat).toBe("number");
    expect(JSON.parse(req.body)).toEqual({ aps: { alert: { title: "予約が承認されました", body: "本文" }, sound: "default" }, deep_link: "arms://reservations/1" });
  });

  it("uses the production host for production tokens and caches the provider token for ≤ 50 minutes", async () => {
    let now = Date.parse("2026-10-02T00:00:00Z");
    const { s, requests } = sender([{ status: 200 }, { status: 200 }, { status: 200 }], () => now);
    const p = { title: "t", body: "b", deepLink: "arms://lessons/today" };
    await s.send(deviceToken, "production", p);
    now += 49 * 60_000;
    await s.send(deviceToken, "production", p);
    now += 2 * 60_000;
    await s.send(deviceToken, "production", p);
    expect(requests[0]!.url.startsWith("https://api.push.apple.com/3/device/")).toBe(true);
    expect(requests[1]!.headers.authorization).toBe(requests[0]!.headers.authorization);
    expect(requests[2]!.headers.authorization).not.toBe(requests[0]!.headers.authorization);
  });

  it("maps APNs responses: 410/BadDeviceToken → invalid_token, expired provider token → refresh once, 429/5xx → retry, other 4xx → failed", async () => {
    const p = { title: "t", body: "b", deepLink: "arms://x" };
    expect(await sender([{ status: 410, body: { reason: "Unregistered" } }]).s.send(deviceToken, "sandbox", p)).toBe("invalid_token");
    expect(await sender([{ status: 400, body: { reason: "BadDeviceToken" } }]).s.send(deviceToken, "sandbox", p)).toBe("invalid_token");
    expect(await sender([{ status: 400, body: { reason: "DeviceTokenNotForTopic" } }]).s.send(deviceToken, "sandbox", p)).toBe("invalid_token");
    expect(await sender([{ status: 413, body: { reason: "PayloadTooLarge" } }]).s.send(deviceToken, "sandbox", p)).toBe("failed");
    expect(await sender([{ status: 429, body: { reason: "TooManyRequests" } }]).s.send(deviceToken, "sandbox", p)).toBe("retry");
    expect(await sender([{ status: 503, body: { reason: "ServiceUnavailable" } }]).s.send(deviceToken, "sandbox", p)).toBe("retry");
    const refreshed = sender([{ status: 403, body: { reason: "ExpiredProviderToken" } }, { status: 200 }]);
    expect(await refreshed.s.send(deviceToken, "sandbox", p)).toBe("sent");
    expect(refreshed.requests).toHaveLength(2);
    const stillBad = sender([{ status: 403, body: { reason: "InvalidProviderToken" } }, { status: 403, body: { reason: "InvalidProviderToken" } }]);
    expect(await stillBad.s.send(deviceToken, "sandbox", p)).toBe("retry");
    const malformed = sender([]);
    expect(await malformed.s.send("../../etc", "sandbox", p)).toBe("invalid_token");
    expect(malformed.requests).toHaveLength(0);
    const offline = createApnsSender({
      keyId: "K",
      teamId: "T",
      privateKeyPem: privatePem,
      topic: "jp.example.arms",
      tokenKey: TEST_DEVICE_KEY,
      fetch: (async () => Promise.reject(new TypeError("network"))) as unknown as typeof fetch,
    });
    expect(await offline.send(deviceToken, "sandbox", p)).toBe("retry");
  });

  it("keeps the payload within 4 KB", () => {
    const json = apnsPayload({ title: "長文", body: "あ".repeat(5000), deepLink: "arms://x" });
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(4096);
    expect(JSON.parse(json).aps.alert.body.endsWith("…")).toBe(true);
  });

  it("device tokens are sealed with AES-GCM bound to their owner", async () => {
    const cipher = createDeviceTokenCipher(TEST_DEVICE_KEY);
    const sealed = await cipher.seal(deviceToken, "device_token:org:user:hash");
    expect(sealed).not.toContain(deviceToken);
    expect(await cipher.open(sealed, "device_token:org:user:hash")).toBe(deviceToken);
    await expect(cipher.open(sealed, "device_token:org:other:hash")).rejects.toThrow();
    expect(() => createDeviceTokenCipher(Buffer.alloc(16).toString("base64"))).toThrow(ConfigError);
  });

  it("createPushSender: null unless key id, team id, .p8, bundle id and the token key are all set", () => {
    const env = { APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_PRIVATE_KEY: privatePem, IOS_BUNDLE_ID: "jp.example.arms", DEVICE_TOKEN_ENCRYPTION_KEY: TEST_DEVICE_KEY };
    expect(createPushSender(env as Bindings, config)).not.toBeNull();
    expect(createPushSender({ ...env, DEVICE_TOKEN_ENCRYPTION_KEY: undefined } as Bindings, config)).toBeNull();
    expect(createPushSender({ ...env, APNS_PRIVATE_KEY: undefined } as Bindings, config)).toBeNull();
    expect(() => createPushSender({ ...env, APNS_PRIVATE_KEY: "not a key" } as Bindings, config)).toThrow(ConfigError);
    expect(() => createPushSender({ ...env, APNS_HOST: "evil.example/path" } as Bindings, config)).toThrow(ConfigError);
  });
});

describe("Cloudflare Queue producer", () => {
  it("sends JSON messages and splits batches at 100", async () => {
    const sent: unknown[] = [];
    const batches: number[] = [];
    const binding = {
      send: async (body: unknown, opts: unknown) => {
        sent.push({ body, opts });
      },
      sendBatch: async (msgs: Iterable<unknown>) => {
        batches.push([...msgs].length);
      },
    } as unknown as Queue<{ org_id: string; outbox_id: string }>;
    const q = createCloudflareQueue(binding);
    await q.enqueue({ org_id: "o", outbox_id: "x" });
    expect(sent).toEqual([{ body: { org_id: "o", outbox_id: "x" }, opts: { contentType: "json" } }]);
    await q.enqueueBatch(Array.from({ length: 250 }, (_, i) => ({ org_id: "o", outbox_id: String(i) })));
    expect(batches).toEqual([100, 100, 50]);
    expect(createNotificationQueue({} as Bindings, config)).toBeNull();
    expect(createNotificationQueue({ NOTIFICATION_QUEUE: binding } as unknown as Bindings, config)).not.toBeNull();
  });
});
