import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, cookieCaller, type TestContext } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { seedOrg } from "../helpers/fixtures";
import { contextWith, learningWorld, type LearningWorld } from "../helpers/learning-setup";
import { RequestDb } from "../../src/db/client";
import { PDF_FONT_KEY, buildCsv, csvCell, resetPdfFontCache } from "../../src/domain/learning/export-render";
import { expireExportFiles, generateExports, runLearningJobs } from "../../src/jobs/learning";

const FONT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../assets/fonts/NotoSansJP-Regular-CP932.ttf"));

let w: LearningWorld;
let noStorage: TestContext;

async function record(studentId: string, teacherId: string, due: string, content: string, notes = "", department = "開発部", orgId = w.org.orgId) {
  await w.ctx.admin.query(
    `INSERT INTO app.progress_records(org_id, student_id, teacher_id, department_name, teacher_name_snapshot, due_date, content, notes, state)
     VALUES ($1, $2, $3, $4, (SELECT display_name FROM app.users WHERE id = $3), $5, $6, $7, 'in_progress')`,
    [orgId, studentId, teacherId, department, due, content, notes],
  );
}

beforeAll(async () => {
  w = await learningWorld();
  noStorage = contextWith({ storage: null, scanner: null });
  await record(w.org.student.userId, w.org.teacher.userId, "2026-10-05", "技術知識習得・プログラム言語習得");
  await record(w.org.student2.userId, w.org.teacher.userId, "2026-10-06", '=HYPERLINK("http://evil.example","クリック")', "+cmd|' /C calc'!A0", "サポート部");
  await record(w.org.student2.userId, w.org.teacher.userId, "2026-10-07", "-2+3", "@SUM(A1:A2)");
  await record(w.org.student2.userId, w.org.teacher.userId, "2026-10-08", "\tタブ始まり", "\r改行始まり");
  await record(w.org.otherStudent.userId, w.org.otherTeacher.userId, "2026-10-08", "営業同行・提案書の作成", "", "営業部");
});
afterAll(async () => {
  await w.ctx.close();
  await noStorage.close();
});

function decodeCsv(key: string): string {
  const bytes = w.storage.objects.get(key)!.bytes;
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return new TextDecoder().decode(bytes.slice(3));
}

describe("CSV formula-injection escaping", () => {
  it("prefixes cells starting with = + - @ TAB CR and doubles quotes", () => {
    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
    expect(csvCell("+81")).toBe(`"'+81"`);
    expect(csvCell("-5")).toBe(`"'-5"`);
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    expect(csvCell("\tx")).toBe(`"'\tx"`);
    expect(csvCell("\rx")).toBe(`"'\rx"`);
    expect(csvCell('say "hi"')).toBe(`"say ""hi"""`);
    expect(csvCell("和田 一夫")).toBe(`"和田 一夫"`);
    expect(csvCell(null)).toBe(`""`);
    const csv = new TextDecoder().decode(buildCsv([]).slice(3));
    expect(csv).toBe(`"終了予定日","社員名","教育担当部署","教育担当者","内容","状態","期限超過","進捗率(%)","社員番号","クラス","備考"\r\n`);
  });
});

describe("POST /exports/progress (CSV)", () => {
  it("generates a UTF-8 BOM CSV with the legacy Japanese headers and escaped cells", async () => {
    const res = await call(w.ctx, w.admin, "POST", "/exports/progress", { body: { format: "csv", month: "2026-10" }, idempotencyKey: false });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/exports/progress");
    expect(res.body.data).toMatchObject({ state: "ready", format: "csv", row_count: 5, filename: "社員教育進捗_2026-10.csv", error_code: null });
    expect(res.body.data.download_url).toContain("X-Amz-Expires=300");
    const key = `exports/${w.org.orgId}/${res.body.data.id}.csv`;
    const csv = decodeCsv(key);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(`"終了予定日","社員名","教育担当部署","教育担当者","内容","状態","期限超過","進捗率(%)","社員番号","クラス","備考"`);
    expect(lines[1]).toMatch(/^"2026-10-05","和田 一夫","開発部","田中 祥司","技術知識習得・プログラム言語習得","受講中","","未設定","E-/);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""クリック"")"`);
    expect(csv).toContain(`"'+cmd|' /C calc'!A0"`);
    expect(csv).toContain(`"'-2+3"`);
    expect(csv).toContain(`"'@SUM(A1:A2)"`);
    expect(csv).toContain(`"'\tタブ始まり"`);
    expect(csv).toContain(`"'\r改行始まり"`);
    expect(w.storage.objects.get(key)!.contentType).toBe("text/csv; charset=utf-8");
    const audit = await w.ctx.admin.query("SELECT event_type FROM app.audit_events WHERE entity_id = $1 ORDER BY created_at", [res.body.data.id]);
    expect(audit.rows.map((r) => r.event_type)).toEqual(["export.requested", "export.generated"]);
  });

  it("applies the teacher's scope and the list filters", async () => {
    const res = await call(w.ctx, w.otherTeacher, "POST", "/exports/progress", { body: { format: "csv" }, idempotencyKey: false });
    expect(res.status).toBe(200);
    const csv = decodeCsv(`exports/${w.org.orgId}/${res.body.data.id}.csv`);
    expect(csv).toContain("営業同行");
    expect(csv).not.toContain("和田 一夫");
    const filtered = await call(w.ctx, w.admin, "POST", "/exports/progress", { body: { format: "csv", department: "サポート部" }, idempotencyKey: false });
    expect(filtered.body.data.row_count).toBe(1);
    const bad = await call(w.ctx, w.admin, "POST", "/exports/progress", { body: { format: "xlsx", month: "10月" } });
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors.month).toBe("YYYY-MM形式で指定してください。");
    expect((await call(w.ctx, w.student, "POST", "/exports/progress", { body: { format: "csv" } })).status).toBe(403);
    expect((await call(w.ctx, null, "POST", "/exports/progress", { body: { format: "csv" } })).status).toBe(401);
    const none = await call(noStorage, w.admin, "POST", "/exports/progress", { body: { format: "csv" } });
    expect(none.status).toBe(503);
    expect(none.body.code).toBe("NOT_CONFIGURED");
  });
});

describe("PDF export", () => {
  it("fails clearly (no fake file) when the Japanese font is not deployed", async () => {
    resetPdfFontCache();
    w.storage.objects.delete(PDF_FONT_KEY);
    const res = await call(w.ctx, w.admin, "POST", "/exports/progress", { body: { format: "pdf", month: "2026-10" } });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PDF_FONT_UNAVAILABLE");
    expectContract(res, "post", "/exports/progress");
    const job = await w.ctx.admin.query("SELECT id, state, error_code FROM app.export_jobs WHERE org_id = $1 AND format = 'pdf' ORDER BY created_at DESC LIMIT 1", [w.org.orgId]);
    expect(job.rows[0]).toMatchObject({ state: "failed", error_code: "PDF_FONT_UNAVAILABLE" });
    const get = await call(w.ctx, w.admin, "GET", `/exports/${job.rows[0].id}`);
    expect(get.body.data).toMatchObject({ state: "failed", download_url: null, error_code: "PDF_FONT_UNAVAILABLE" });
  });

  it("renders Japanese text with an embedded Noto Sans JP subset", async () => {
    resetPdfFontCache();
    w.storage.clientPut(PDF_FONT_KEY, new Uint8Array(FONT), "font/ttf");
    const res = await call(w.ctx, w.admin, "POST", "/exports/progress", { body: { format: "pdf", month: "2026-10" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ state: "ready", format: "pdf", filename: "社員教育進捗_2026-10.pdf" });
    const bytes = w.storage.objects.get(`exports/${w.org.orgId}/${res.body.data.id}.pdf`)!.bytes;
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(200_000); // subset, not the whole 2.5 MB font
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false }).promise;
    const page = await doc.getPage(1);
    const text = (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
    for (const s of ["社員教育進捗管理", "終了予定日", "社員名", "教育担当部署", "教育担当者", "内容", "和田 一夫", "田中 祥司", "技術知識習得", "2026年10月5日（月）"]) {
      expect(text, s).toContain(s);
    }
    // The font program itself is embedded (FontFile2 = TrueType glyph data), not referenced by name.
    const loaded = await PDFDocument.load(bytes);
    const embedded = loaded.context.enumerateIndirectObjects().filter(([, obj]) => obj instanceof PDFDict && obj.has(PDFName.of("FontFile2")));
    expect(embedded.length).toBe(1);
  });
});

describe("GET /exports/{id} and background generation", () => {
  it("returns a fresh 5-minute URL to the requester only", async () => {
    const created = await call(w.ctx, w.teacher, "POST", "/exports/progress", { body: { format: "csv" } });
    const id = created.body.data.id;
    const res = await call(w.ctx, w.teacher, "GET", `/exports/${id}`);
    expect(res.status).toBe(200);
    expectContract(res, "get", "/exports/{id}");
    expect(res.body.data.state).toBe("ready");
    expect(new Date(res.body.data.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect((await call(w.ctx, w.otherTeacher, "GET", `/exports/${id}`)).status).toBe(404);
    expect((await call(w.ctx, w.admin, "GET", `/exports/${id}`)).status).toBe(404);
    expect((await call(w.ctx, w.student, "GET", `/exports/${id}`)).status).toBe(403);
    expect((await call(w.ctx, null, "GET", `/exports/${id}`)).status).toBe(401);
  });

  it("generates large exports in the cron job and expires files after retention", async () => {
    const big = await seedOrg(w.ctx.admin);
    await w.ctx.admin.query(
      `INSERT INTO app.progress_records(org_id, student_id, teacher_id, department_name, teacher_name_snapshot, due_date, content, state)
       SELECT $1, $2, $3, '開発部', '田中 祥司', DATE '2026-10-01' + (g % 28), '研修 ' || g, 'in_progress' FROM generate_series(1, 501) g`,
      [big.orgId, big.student.userId, big.teacher.userId],
    );
    const bigAdmin = await cookieCaller(w.ctx, { userId: big.admin.userId, orgId: big.orgId, role: "admin" });
    const res = await call(w.ctx, bigAdmin, "POST", "/exports/progress", { body: { format: "csv" } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: "pending", download_url: null });
    const db = new RequestDb(w.ctx.deps.connections);
    try {
      expect(await generateExports(w.ctx.deps, db, big.orgId)).toBe(1);
      const ready = await call(w.ctx, bigAdmin, "GET", `/exports/${res.body.data.id}`);
      expect(ready.body.data).toMatchObject({ state: "ready", row_count: 501 });
      const csv = decodeCsv(`exports/${big.orgId}/${res.body.data.id}.csv`);
      expect(csv.trim().split("\r\n")).toHaveLength(502);

      await w.ctx.admin.query("UPDATE app.export_jobs SET file_expires_at = now() - interval '1 minute' WHERE id = $1", [res.body.data.id]);
      expect(await expireExportFiles(w.ctx.deps, db, big.orgId)).toBe(1);
      expect(w.storage.objects.has(`exports/${big.orgId}/${res.body.data.id}.csv`)).toBe(false);
      const expired = await call(w.ctx, bigAdmin, "GET", `/exports/${res.body.data.id}`);
      expect(expired.body.data).toMatchObject({ state: "expired", download_url: null });
    } finally {
      await db.close();
    }
  });

  it("refuses more than 10,000 rows", async () => {
    const huge = await seedOrg(w.ctx.admin);
    await w.ctx.admin.query(
      `INSERT INTO app.progress_records(org_id, student_id, teacher_id, department_name, teacher_name_snapshot, due_date, content, state)
       SELECT $1, $2, $3, '開発部', '田中 祥司', DATE '2026-10-01', '研修', 'in_progress' FROM generate_series(1, 10001)`,
      [huge.orgId, huge.student.userId, huge.teacher.userId],
    );
    const hugeAdmin = await cookieCaller(w.ctx, { userId: huge.admin.userId, orgId: huge.orgId, role: "admin" });
    const res = await call(w.ctx, hugeAdmin, "POST", "/exports/progress", { body: { format: "csv" } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EXPORT_TOO_LARGE");
  });

  it("runs every learning job across organisations without failing", async () => {
    await runLearningJobs(w.ctx.deps);
    expect(w.ctx.logs.filter((l) => l.msg === "learning_job_failed")).toEqual([]);
  });
});
