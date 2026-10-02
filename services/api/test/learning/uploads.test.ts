import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, type Caller, type TestContext } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { SAMPLE } from "../helpers/learning-fakes";
import { contextWith, learningWorld, type LearningWorld } from "../helpers/learning-setup";
import { RequestDb } from "../../src/db/client";
import { pollScans, expireUploads } from "../../src/jobs/learning";

let w: LearningWorld;
let noScanner: TestContext;
let noStorage: TestContext;

beforeAll(async () => {
  w = await learningWorld();
  noScanner = contextWith({ storage: w.storage, scanner: null });
  noStorage = contextWith({ storage: null, scanner: null });
});
afterAll(async () => {
  await w.ctx.close();
  await noScanner.close();
  await noStorage.close();
});

const MB = 1024 * 1024;

async function presign(caller: Caller, body: Record<string, unknown>, ctx: TestContext = w.ctx) {
  return call(ctx, caller, "POST", "/uploads", { body });
}

async function upload(caller: Caller, contentType: string, filename: string, bytes: Uint8Array, purpose = "material", ctx: TestContext = w.ctx) {
  const res = await presign(caller, { filename, content_type: contentType, size_bytes: bytes.length, purpose }, ctx);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  w.storage.clientPut(res.body.data.object_key, bytes, contentType);
  const done = await call(ctx, caller, "POST", `/uploads/${res.body.data.id}/complete`);
  return { id: res.body.data.id as string, key: res.body.data.object_key as string, done };
}

describe("POST /uploads", () => {
  it("issues a 15-minute presigned PUT into quarantine/<org>/<uuid> (never the filename)", async () => {
    const res = await presign(w.admin, { filename: "../../etc/研修資料.pdf", content_type: "application/pdf", size_bytes: 1000, purpose: "material" });
    expect(res.status).toBe(422);
    expect(res.body.field_errors.filename).toContain("使用できない文字");

    const ok = await presign(w.admin, { filename: "研修資料.pdf", content_type: "application/pdf", size_bytes: 1000, purpose: "material" });
    expect(ok.status).toBe(200);
    expectContract(ok, "post", "/uploads");
    expect(ok.body.data.object_key).toMatch(new RegExp(`^quarantine/${w.org.orgId}/[0-9a-f-]{36}$`));
    expect(ok.body.data.object_key).not.toContain("研修資料");
    expect(ok.body.data.required_headers).toEqual({ "Content-Type": "application/pdf" });
    const signed = w.storage.presigned.at(-1)!;
    expect(signed).toMatchObject({ method: "PUT", expiresSeconds: 900, contentType: "application/pdf", sizeBytes: 1000 });
    const row = await w.ctx.admin.query("SELECT state, scan_state, filename, expires_at > now() + interval '50 minutes' AS long_deadline FROM app.upload_jobs WHERE id = $1", [ok.body.data.id]);
    expect(row.rows[0]).toMatchObject({ state: "awaiting_upload", scan_state: "pending", filename: "研修資料.pdf", long_deadline: true });
  });

  it("enforces the content-type allowlist, extension match and per-type size limits", async () => {
    const exe = await presign(w.admin, { filename: "setup.exe", content_type: "application/x-msdownload", size_bytes: 10, purpose: "material" });
    expect(exe.status).toBe(422);
    expect(exe.body.field_errors.content_type).toBe("このファイル形式はアップロードできません。");
    const ext = await presign(w.admin, { filename: "guide.png", content_type: "application/pdf", size_bytes: 10, purpose: "material" });
    expect(ext.body.field_errors.filename).toContain(".pdf");
    for (const [type, name, limit] of [
      ["application/pdf", "a.pdf", 20 * MB],
      ["video/mp4", "a.mp4", 200 * MB],
      ["image/jpeg", "a.jpg", 10 * MB],
    ] as const) {
      const atLimit = await presign(w.admin, { filename: name, content_type: type, size_bytes: limit, purpose: "material" });
      expect(atLimit.status, type).toBe(200);
      const over = await presign(w.admin, { filename: name, content_type: type, size_bytes: limit + 1, purpose: "material" });
      expect(over.status, type).toBe(422);
      expect(over.body.code).toBe("FILE_TOO_LARGE");
      expect(over.body.field_errors.size_bytes).toContain("MB以下");
    }
    const csv = await presign(w.admin, { filename: "students.csv", content_type: "text/csv", size_bytes: 10 * MB + 1, purpose: "import" });
    expect(csv.body.code).toBe("FILE_TOO_LARGE");
    const assignment = await presign(w.student, { filename: "report.pdf", content_type: "application/pdf", size_bytes: 20 * MB + 1, purpose: "assignment" });
    expect(assignment.body.code).toBe("FILE_TOO_LARGE");
    const video = await presign(w.student, { filename: "a.mp4", content_type: "video/mp4", size_bytes: 10, purpose: "assignment" });
    expect(video.body.field_errors.content_type).toBeTruthy();
    const long = await presign(w.admin, { filename: `${"あ".repeat(201)}.pdf`, content_type: "application/pdf", size_bytes: 10, purpose: "material" });
    expect(long.status).toBe(422);
    expect(long.body.field_errors.filename).toBe("200文字以内で入力してください。");
  });

  it("restricts purposes by role and needs storage", async () => {
    expect((await presign(w.student, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 10, purpose: "material" })).status).toBe(403);
    expect((await presign(w.teacher, { filename: "a.csv", content_type: "text/csv", size_bytes: 10, purpose: "import" })).status).toBe(403);
    expect((await presign(w.teacher, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 10, purpose: "assignment" })).status).toBe(403);
    expect((await call(w.ctx, null, "POST", "/uploads", { body: { filename: "a.pdf", content_type: "application/pdf", size_bytes: 10, purpose: "material" } })).status).toBe(401);
    const none = await presign(w.admin, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 10, purpose: "material" }, noStorage);
    expect(none.status).toBe(503);
    expect(none.body.code).toBe("NOT_CONFIGURED");
    expectContract(none, "post", "/uploads");
  });
});

describe("POST /uploads/{id}/complete", () => {
  it("verifies size and magic bytes, scans, and moves clean files out of quarantine", async () => {
    const { id, key, done } = await upload(w.admin, "application/pdf", "guide.pdf", SAMPLE.pdf());
    expect(done.status).toBe(200);
    expectContract(done, "post", "/uploads/{id}/complete");
    expect(done.body.data).toMatchObject({ state: "clean", scan_state: "clean", scanner_configured: true });
    expect(w.storage.objects.has(key)).toBe(false);
    const row = (await w.ctx.admin.query("SELECT object_key, detected_type, size_bytes FROM app.upload_jobs WHERE id = $1", [id])).rows[0];
    expect(row.object_key).toMatch(new RegExp(`^materials/${w.org.orgId}/[0-9a-f-]{36}$`));
    expect(w.storage.objects.has(row.object_key)).toBe(true);
    expect(row.detected_type).toBe("application/pdf");
    const submission = w.scanner.submissions.at(-1)!;
    expect(submission.objectKey).toBe(key);
    expect(submission.callbackUrl).toContain(`/api/v1/uploads/${id}/scan-result?org=${w.org.orgId}`);
    const scanGet = w.storage.presigned.find((p) => p.method === "GET" && p.key === key)!;
    expect(scanGet.expiresSeconds).toBe(900);
    const status = await call(w.ctx, w.admin, "GET", `/uploads/${id}`);
    expect(status.status).toBe(200);
    expectContract(status, "get", "/uploads/{id}");
    expect(status.body.data).toMatchObject({ state: "clean", object_key: key, filename: "guide.pdf" });
    // Completing again is idempotent.
    const again = await call(w.ctx, w.admin, "POST", `/uploads/${id}/complete`);
    expect(again.body.data.state).toBe("clean");
  });

  it("accepts every allowed type by its real bytes (PNG, JPEG, MP4, MOV, WebM, UTF-8/CP932 CSV)", async () => {
    const cases: [string, string, Uint8Array, string, Caller][] = [
      ["image/png", "a.png", SAMPLE.png(), "material", w.admin],
      ["image/jpeg", "a.jpeg", SAMPLE.jpeg(), "material", w.admin],
      ["video/mp4", "a.mp4", SAMPLE.mp4(), "material", w.admin],
      ["video/quicktime", "a.mov", SAMPLE.mov(), "material", w.admin],
      ["video/webm", "a.webm", SAMPLE.webm(), "material", w.admin],
      ["text/csv", "a.csv", SAMPLE.csvUtf8(), "import", w.admin],
      ["application/vnd.ms-excel", "b.csv", SAMPLE.csvCp932(), "import", w.admin],
      ["image/png", "report.png", SAMPLE.png(), "assignment", w.student],
    ];
    for (const [type, name, bytes, purpose, caller] of cases) {
      const { done } = await upload(caller, type, name, bytes, purpose);
      expect(done.status, `${type} ${JSON.stringify(done.body)}`).toBe(200);
      expect(done.body.data.state).toBe("clean");
    }
    const imported = await w.ctx.admin.query("SELECT object_key FROM app.upload_jobs WHERE org_id = $1 AND purpose = 'import' AND state = 'clean'", [w.org.orgId]);
    expect(imported.rows.every((r) => r.object_key.startsWith(`imports/${w.org.orgId}/`))).toBe(true);
  });

  it("rejects content that does not match the declared type (magic bytes) and deletes it", async () => {
    for (const [type, name, bytes] of [
      ["application/pdf", "fake.pdf", SAMPLE.exe()],
      ["image/png", "fake.png", SAMPLE.jpeg()],
      ["video/mp4", "fake.mp4", SAMPLE.mov()],
      ["video/quicktime", "fake.mov", SAMPLE.mp4()],
      ["video/webm", "fake.webm", SAMPLE.png()],
    ] as const) {
      const { id, key, done } = await upload(w.admin, type, name, bytes);
      expect(done.status, type).toBe(422);
      expect(done.body.code).toBe("FILE_REJECTED");
      expect(done.body.message_ja).toContain("一致しません");
      expectContract(done, "post", "/uploads/{id}/complete");
      expect(w.storage.objects.has(key)).toBe(false);
      const row = (await w.ctx.admin.query("SELECT state, reject_code FROM app.upload_jobs WHERE id = $1", [id])).rows[0];
      expect(row).toEqual({ state: "rejected", reject_code: "content_mismatch" });
    }
    const nul = await upload(w.admin, "text/csv", "bad.csv", new TextEncoder().encode("a,b\u0000c\n"), "import");
    expect(nul.done.body.code).toBe("FILE_REJECTED");
    const binary = await upload(w.admin, "text/csv", "bad2.csv", new Uint8Array([0x41, 0xff, 0xfe, 0x80, 0x0a]), "import");
    expect(binary.done.body.code).toBe("FILE_REJECTED");
  });

  it("requires the uploaded object, the declared size, the uploader and an unexpired job", async () => {
    const res = await presign(w.admin, { filename: "x.pdf", content_type: "application/pdf", size_bytes: 50, purpose: "material" });
    const missing = await call(w.ctx, w.admin, "POST", `/uploads/${res.body.data.id}/complete`);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("UPLOAD_NOT_RECEIVED");
    w.storage.clientPut(res.body.data.object_key, SAMPLE.pdf(), "application/pdf");
    const size = await call(w.ctx, w.admin, "POST", `/uploads/${res.body.data.id}/complete`);
    expect(size.status).toBe(422);
    expect(size.body.message_ja).toContain("サイズ");

    const other = await presign(w.teacher, { filename: "y.pdf", content_type: "application/pdf", size_bytes: SAMPLE.pdf().length, purpose: "material" });
    w.storage.clientPut(other.body.data.object_key, SAMPLE.pdf(), "application/pdf");
    expect((await call(w.ctx, w.admin, "POST", `/uploads/${other.body.data.id}/complete`)).status).toBe(404);
    expect((await call(w.ctx, w.student, "GET", `/uploads/${other.body.data.id}`)).status).toBe(404);
    expect((await call(w.ctx, w.admin, "GET", `/uploads/${other.body.data.id}`)).status).toBe(200);

    // Bearer caller: moving the clock would idle out a Web session.
    const late = await presign(w.teacher, { filename: "z.pdf", content_type: "application/pdf", size_bytes: SAMPLE.pdf().length, purpose: "material" });
    w.storage.clientPut(late.body.data.object_key, SAMPLE.pdf(), "application/pdf");
    w.ctx.clock.now = new Date(Date.now() + 2 * 3600 * 1000);
    const expired = await call(w.ctx, w.teacher, "POST", `/uploads/${late.body.data.id}/complete`);
    w.ctx.clock.now = null;
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe("UPLOAD_EXPIRED");
    expect(w.storage.objects.has(late.body.data.object_key)).toBe(false);
  });

  it("deletes and records files the scanner blocks (EICAR)", async () => {
    const { id, key, done } = await upload(w.admin, "application/pdf", "eicar.pdf", SAMPLE.eicarPdf());
    expect(done.status).toBe(422);
    expect(done.body.code).toBe("FILE_REJECTED");
    expect(done.body.details).toMatchObject({ scan_state: "blocked" });
    expect(w.storage.objects.has(key)).toBe(false);
    const row = (await w.ctx.admin.query("SELECT state, scan_state FROM app.upload_jobs WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ state: "blocked", scan_state: "blocked" });
    const events = await w.ctx.admin.query("SELECT event_type FROM app.audit_events WHERE entity_id = $1", [id]);
    expect(events.rows.map((r) => r.event_type)).toContain("upload.scan_blocked");
    const ob = await w.ctx.admin.query("SELECT payload FROM app.outbox WHERE entity_id = $1", [id]);
    expect(ob.rows[0].payload).toMatchObject({ verdict: "blocked" });
  });

  it("keeps files pending (never clean) without a scanner, and the job submits them once a scanner exists", async () => {
    const { id, done } = await upload(w.admin, "application/pdf", "noscan.pdf", SAMPLE.pdf(), "material", noScanner);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ state: "scanning", scan_state: "pending", scanner_configured: false });
    const db = new RequestDb(w.ctx.deps.connections);
    try {
      expect(await pollScans(noScanner.deps, db, w.org.orgId)).toBe(0);
      expect((await w.ctx.admin.query("SELECT scan_state FROM app.upload_jobs WHERE id = $1", [id])).rows[0].scan_state).toBe("pending");
      await pollScans(w.ctx.deps, db, w.org.orgId);
    } finally {
      await db.close();
    }
    expect((await w.ctx.admin.query("SELECT state FROM app.upload_jobs WHERE id = $1", [id])).rows[0].state).toBe("clean");
  });

  it("handles asynchronous verdicts through status polling and an unreachable scanner", async () => {
    w.scanner.mode = "async";
    const { id, done } = await upload(w.admin, "application/pdf", "async.pdf", SAMPLE.pdf());
    w.scanner.mode = "sync";
    expect(done.body.data).toMatchObject({ state: "scanning", scan_state: "pending" });
    const scanRef = (await w.ctx.admin.query("SELECT scan_reference FROM app.upload_jobs WHERE id = $1", [id])).rows[0].scan_reference;
    expect(scanRef).toMatch(/^scan-/);
    const db = new RequestDb(w.ctx.deps.connections);
    try {
      expect(await pollScans(w.ctx.deps, db, w.org.orgId)).toBe(0);
      w.scanner.finish(scanRef);
      expect(await pollScans(w.ctx.deps, db, w.org.orgId)).toBe(1);
      expect((await w.ctx.admin.query("SELECT state FROM app.upload_jobs WHERE id = $1", [id])).rows[0].state).toBe("clean");

      w.scanner.mode = "down";
      const down = await upload(w.admin, "application/pdf", "down.pdf", SAMPLE.pdf());
      expect(down.done.status).toBe(200);
      expect(down.done.body.data.scan_state).toBe("pending");
      expect(await pollScans(w.ctx.deps, db, w.org.orgId)).toBe(0);
      w.scanner.mode = "sync";
      expect(await pollScans(w.ctx.deps, db, w.org.orgId)).toBe(1);
    } finally {
      w.scanner.mode = "sync";
      await db.close();
    }
  });

  it("expires uploads that were never completed and deletes their quarantine object", async () => {
    const res = await presign(w.admin, { filename: "late.pdf", content_type: "application/pdf", size_bytes: 10, purpose: "material" });
    w.storage.clientPut(res.body.data.object_key, "%PDF-1.4 xx", "application/pdf");
    await w.ctx.admin.query("UPDATE app.upload_jobs SET expires_at = now() - interval '1 minute' WHERE id = $1", [res.body.data.id]);
    const db = new RequestDb(w.ctx.deps.connections);
    try {
      expect(await expireUploads(w.ctx.deps, db, w.org.orgId)).toBeGreaterThanOrEqual(1);
    } finally {
      await db.close();
    }
    expect((await w.ctx.admin.query("SELECT state FROM app.upload_jobs WHERE id = $1", [res.body.data.id])).rows[0].state).toBe("expired");
    expect(w.storage.objects.has(res.body.data.object_key)).toBe(false);
    const done = await call(w.ctx, w.admin, "POST", `/uploads/${res.body.data.id}/complete`);
    expect(done.body.code).toBe("UPLOAD_EXPIRED");
  });
});
