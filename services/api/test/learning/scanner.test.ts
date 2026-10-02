import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/context";
import { uploadRoutes } from "../../src/routes/learning/uploads";
import { expectContract } from "../helpers/contract";
import { call } from "../helpers/app";
import { SAMPLE } from "../helpers/learning-fakes";
import { learningWorld, type LearningWorld } from "../helpers/learning-setup";
import { RequestDb, type Tx } from "../../src/db/client";
import { ApiError } from "../../src/http/errors";
import { createHttpScanner, mapScanStatus, signScanCallback, verifyScanCallback } from "../../src/integrations/scanner";
import { handleScanCallback } from "../../src/domain/learning/uploads";

// ---- a minimal scanner service speaking the documented protocol ---------------------------------

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}
let server: Server;
let base: string;
const seen: Seen[] = [];
const scans = new Map<string, string>();
let nextStatus = "clean";
let failWith: number | null = null;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

let w: LearningWorld;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
    if (failWith) {
      res.writeHead(failWith).end("upstream error");
      return;
    }
    if (req.method === "POST" && req.url === "/v1/scans") {
      const id = `s-${scans.size + 1}`;
      scans.set(id, nextStatus);
      res.writeHead(nextStatus === "pending" ? 202 : 200, { "content-type": "application/json" }).end(JSON.stringify({ scan_id: id, status: nextStatus }));
      return;
    }
    const m = /^\/v1\/scans\/(.+)$/.exec(req.url ?? "");
    if (req.method === "GET" && m) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ scan_id: m[1], status: scans.get(decodeURIComponent(m[1]!)) ?? "unknown" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  w = await learningWorld();
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await w.ctx.close();
});

describe("HTTP scanner client", () => {
  it("submits a presigned URL with the API key and maps synchronous verdicts", async () => {
    const scanner = createHttpScanner({ url: `${base}/`, apiKey: "k-123" });
    nextStatus = "clean";
    const clean = await scanner.submit({ uploadId: "u1", objectKey: "quarantine/o/u1", downloadUrl: "https://storage/u1?sig", callbackUrl: "https://app/cb" });
    expect(clean).toEqual({ verdict: "clean", scanId: "s-1" });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/v1/scans", auth: "Bearer k-123", body: { upload_id: "u1", download_url: "https://storage/u1?sig", callback_url: "https://app/cb" } });
    nextStatus = "infected";
    expect((await scanner.submit({ uploadId: "u2", objectKey: "k", downloadUrl: "https://s/2" })).verdict).toBe("blocked");
  });

  it("supports asynchronous scans via status polling; unknown statuses stay pending", async () => {
    const scanner = createHttpScanner({ url: base, apiKey: "k-123" });
    nextStatus = "pending";
    const pending = await scanner.submit({ uploadId: "u3", objectKey: "k", downloadUrl: "https://s/3" });
    expect(pending.verdict).toBe("pending");
    expect(await scanner.status(pending.scanId!)).toBe("pending");
    scans.set(pending.scanId!, "clean");
    expect(await scanner.status(pending.scanId!)).toBe("clean");
    scans.set(pending.scanId!, "error");
    expect(await scanner.status(pending.scanId!)).toBe("pending");
  });

  it("raises SCANNER_UNAVAILABLE on transport/HTTP errors (never a clean verdict)", async () => {
    const scanner = createHttpScanner({ url: base, apiKey: "k-123" });
    failWith = 500;
    await expect(scanner.submit({ uploadId: "u4", objectKey: "k", downloadUrl: "https://s/4" })).rejects.toMatchObject({ code: "SCANNER_UNAVAILABLE" });
    failWith = null;
    const unreachable = createHttpScanner({ url: "http://127.0.0.1:1/v1", apiKey: "k", timeoutMs: 2000 });
    await expect(unreachable.status("x")).rejects.toBeInstanceOf(ApiError);
  });

  it("maps provider statuses conservatively", () => {
    expect(mapScanStatus("CLEAN")).toBe("clean");
    expect(mapScanStatus("malicious")).toBe("blocked");
    expect(mapScanStatus("suspicious")).toBe("blocked");
    expect(mapScanStatus("queued")).toBe("pending");
    expect(mapScanStatus("error")).toBe("pending");
    expect(mapScanStatus(undefined)).toBe("pending");
  });
});

describe("scan callback verification (HMAC)", () => {
  const key = "callback-secret";
  const body = JSON.stringify({ scan_id: "s-9", status: "clean" });
  const now = new Date("2026-10-02T03:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  it("accepts the correct signature within the time window", async () => {
    const sig = await signScanCallback(key, ts, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(await verifyScanCallback({ apiKey: key, timestamp: ts, signature: sig, rawBody: body, now })).toBe(true);
    // Rotation: any of several comma-separated signatures may match.
    expect(await verifyScanCallback({ apiKey: key, timestamp: ts, signature: `v1=deadbeef, ${sig}`, rawBody: body, now })).toBe(true);
  });

  it("rejects a wrong key, a tampered body, stale/future timestamps and malformed headers", async () => {
    const sig = await signScanCallback(key, ts, body);
    expect(await verifyScanCallback({ apiKey: "other", timestamp: ts, signature: sig, rawBody: body, now })).toBe(false);
    expect(await verifyScanCallback({ apiKey: key, timestamp: ts, signature: sig, rawBody: body.replace("clean", "blocked"), now })).toBe(false);
    expect(await verifyScanCallback({ apiKey: key, timestamp: String(Number(ts) - 301), signature: await signScanCallback(key, String(Number(ts) - 301), body), rawBody: body, now })).toBe(false);
    expect(await verifyScanCallback({ apiKey: key, timestamp: String(Number(ts) + 301), signature: await signScanCallback(key, String(Number(ts) + 301), body), rawBody: body, now })).toBe(false);
    expect(await verifyScanCallback({ apiKey: key, timestamp: "abc", signature: sig, rawBody: body, now })).toBe(false);
    expect(await verifyScanCallback({ apiKey: key, timestamp: ts, signature: sig.slice(0, -1), rawBody: body, now })).toBe(false);
    expect(await verifyScanCallback({ apiKey: key, timestamp: null, signature: sig, rawBody: body, now })).toBe(false);
    expect(await verifyScanCallback({ apiKey: "", timestamp: ts, signature: sig, rawBody: body, now })).toBe(false);
  });
});

describe("applying asynchronous verdicts (callback handler domain)", () => {
  async function pendingUpload(name: string, bytes: Uint8Array) {
    w.scanner.mode = "async";
    const res = await call(w.ctx, w.admin, "POST", "/uploads", { body: { filename: name, content_type: "application/pdf", size_bytes: bytes.length, purpose: "material" } });
    w.storage.clientPut(res.body.data.object_key, bytes, "application/pdf");
    const done = await call(w.ctx, w.admin, "POST", `/uploads/${res.body.data.id}/complete`);
    w.scanner.mode = "sync";
    expect(done.body.data.scan_state).toBe("pending");
    const ref = (await w.ctx.admin.query("SELECT scan_reference FROM app.upload_jobs WHERE id = $1", [res.body.data.id])).rows[0].scan_reference as string;
    return { id: res.body.data.id as string, ref, key: res.body.data.object_key as string };
  }

  it("applies clean and blocked verdicts once, rejects mismatched scan ids and unknown uploads", async () => {
    const db = new RequestDb(w.ctx.deps.connections);
    const runTx = <T>(fn: (tx: Tx) => Promise<T>) => db.tx({ orgId: w.org.orgId }, fn);
    try {
      const a = await pendingUpload("a.pdf", SAMPLE.pdf());
      await expect(handleScanCallback(runTx, w.storage, w.org.orgId, a.id, "scan-other", "clean")).rejects.toMatchObject({ code: "INVALID_STATE" });
      const still = await handleScanCallback(runTx, w.storage, w.org.orgId, a.id, a.ref, "pending");
      expect(still.state).toBe("scanning");
      const clean = await handleScanCallback(runTx, w.storage, w.org.orgId, a.id, a.ref, "clean");
      expect(clean).toMatchObject({ state: "clean", scan_state: "clean" });
      expect(clean.object_key.startsWith(`materials/${w.org.orgId}/`)).toBe(true);
      const repeat = await handleScanCallback(runTx, w.storage, w.org.orgId, a.id, a.ref, "blocked");
      expect(repeat.state).toBe("clean");

      const b = await pendingUpload("b.pdf", SAMPLE.pdf());
      const blocked = await handleScanCallback(runTx, w.storage, w.org.orgId, b.id, b.ref, "blocked");
      expect(blocked).toMatchObject({ state: "blocked", scan_state: "blocked" });
      expect(w.storage.objects.has(b.key)).toBe(false);

      await expect(handleScanCallback(runTx, w.storage, w.org.orgId, crypto.randomUUID(), "x", "clean")).rejects.toMatchObject({ code: "NOT_FOUND" });
      // Tenant isolation: the same upload id under another organisation's context is invisible.
      const otherOrg = (await w.ctx.admin.query("INSERT INTO app.organizations(name) VALUES ('別組織') RETURNING id")).rows[0].id as string;
      const foreignTx = <T>(fn: (tx: Tx) => Promise<T>) => db.tx({ orgId: otherOrg }, fn);
      await expect(handleScanCallback(foreignTx, w.storage, otherOrg, a.id, a.ref, "clean")).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await db.close();
    }
  });

  it("through the real app: the scanner callback is exempt from user auth but requires a valid signature", async () => {
    const a = await pendingUpload("c.pdf", SAMPLE.pdf());
    const raw = JSON.stringify({ scan_id: a.ref, status: "clean", upload_id: a.id });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signScanCallback(w.scanner.apiKey, ts, raw);
    const headers = { "Content-Type": "application/json", "X-ARMS-Scan-Timestamp": ts, "X-ARMS-Scan-Signature": sig };
    const forged = await w.ctx.app.request(`/api/v1/uploads/${a.id}/scan-result?org=${w.org.orgId}`, {
      method: "POST",
      headers: { ...headers, "X-ARMS-Scan-Signature": "v1=00" },
      body: raw,
    });
    expect(forged.status).toBe(401);
    expect((await w.ctx.admin.query("SELECT state FROM app.upload_jobs WHERE id = $1", [a.id])).rows[0].state).not.toBe("clean");
    const res = await w.ctx.app.request(`/api/v1/uploads/${a.id}/scan-result?org=${w.org.orgId}`, { method: "POST", headers, body: raw });
    const body = (await res.json()) as { data?: { state?: string } };
    expect(res.status).toBe(200);
    expect(body.data?.state).toBe("clean");
    expect((await w.ctx.admin.query("SELECT state FROM app.upload_jobs WHERE id = $1", [a.id])).rows[0].state).toBe("clean");
  });

  it("route handler, mounted without the auth gate (as once public), accepts only signed callbacks", async () => {
    // Same request plumbing as app.ts (deps, per-request DB, error envelope) but no authenticate middleware.
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("deps", w.ctx.deps);
      c.set("requestId", crypto.randomUUID());
      const db = new RequestDb(w.ctx.deps.connections);
      c.set("db", db);
      try {
        await next();
      } finally {
        await db.close();
      }
    });
    app.onError((err, c) => {
      const e = err instanceof ApiError ? err : new ApiError("INTERNAL");
      return c.json({ code: e.code, message_ja: e.message_ja, request_id: "t", ...(e.field_errors ? { field_errors: e.field_errors } : {}) }, e.status as 400);
    });
    app.route("/api/v1", uploadRoutes);

    const a = await pendingUpload("d.pdf", SAMPLE.pdf());
    const raw = JSON.stringify({ scan_id: a.ref, status: "infected", upload_id: a.id, engine: "test" });
    const ts = String(Math.floor(Date.now() / 1000));
    const post = (headers: Record<string, string>, body = raw, org = w.org.orgId) =>
      app.request(`/api/v1/uploads/${a.id}/scan-result?org=${org}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

    const unsigned = await post({});
    expect(unsigned.status).toBe(401);
    expect(((await unsigned.json()) as { code: string }).code).toBe("SCAN_SIGNATURE_INVALID");
    const wrong = await post({ "X-ARMS-Scan-Timestamp": ts, "X-ARMS-Scan-Signature": await signScanCallback("not-the-key", ts, raw) });
    expect(wrong.status).toBe(401);
    const tampered = await post({ "X-ARMS-Scan-Timestamp": ts, "X-ARMS-Scan-Signature": await signScanCallback(w.scanner.apiKey, ts, raw) }, raw.replace("infected", "clean"));
    expect(tampered.status).toBe(401);
    const badOrg = await post({ "X-ARMS-Scan-Timestamp": ts, "X-ARMS-Scan-Signature": await signScanCallback(w.scanner.apiKey, ts, raw) }, raw, "not-a-uuid");
    expect(badOrg.status).toBe(404);
    const otherIdBody = JSON.stringify({ scan_id: a.ref, status: "clean", upload_id: crypto.randomUUID() });
    const mismatch = await post({ "X-ARMS-Scan-Timestamp": ts, "X-ARMS-Scan-Signature": await signScanCallback(w.scanner.apiKey, ts, otherIdBody) }, otherIdBody);
    expect(mismatch.status).toBe(422);

    const ok = await post({ "X-ARMS-Scan-Timestamp": ts, "X-ARMS-Scan-Signature": await signScanCallback(w.scanner.apiKey, ts, raw) });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expectContract({ status: 200, body }, "post", "/uploads/{id}/scan-result");
    expect(body).toMatchObject({ success: true, data: { upload_id: a.id, state: "blocked", scan_state: "blocked" } });
    expect(w.storage.objects.has(a.key)).toBe(false);
  });
});
