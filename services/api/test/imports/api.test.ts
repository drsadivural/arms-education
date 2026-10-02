/**
 * /imports API: permissions and tenant isolation, upload lifecycle checks, mapping validation, dry run with Japanese
 * row errors, error report escaping, item preview, mapping correction, encodings and idempotent commit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { seedOrg, type OrgScenario } from "../helpers/fixtures";
import {
  SAMPLE_COLUMNS,
  commitJob,
  cp932,
  createJob,
  csv,
  importWorld,
  insertUpload,
  items,
  uniq,
  validateJob,
  withBom,
  type ImportWorld,
} from "../helpers/imports-fixtures";

let w: ImportWorld;
let other: OrgScenario;
let otherAdmin: Caller;
let noScanner: TestContext;
let noStorage: TestContext;
let studentNo: string;
let teacherNo: string;

beforeAll(async () => {
  w = await importWorld();
  other = await seedOrg(w.ctx.admin);
  otherAdmin = await cookieCaller(w.ctx, { userId: other.admin.userId, orgId: other.orgId, role: "admin" });
  noScanner = createTestContext({ storage: w.storage, scanner: null });
  noStorage = createTestContext({ storage: null, scanner: null });
  const s = await w.ctx.admin.query("SELECT employee_number FROM app.student_profiles WHERE id = $1", [w.org.student.userId]);
  const t = await w.ctx.admin.query("SELECT teacher_number FROM app.teacher_profiles WHERE id = $1", [w.org.teacher.userId]);
  studentNo = s.rows[0].employee_number;
  teacherNo = t.rows[0].teacher_number;
});
afterAll(async () => {
  await w.ctx.close();
  await noScanner.close();
  await noStorage.close();
});

const PROGRESS_HEADER = ["source_record_id", "社員番号", "終了予定日", "教育担当部署", "教育担当講師番号", "教育担当者", "内容", "状態"];
const progressFile = (rows: string[][]) => withBom(csv([PROGRESS_HEADER, ...rows]));
const body = (uploadId: string, extra: Record<string, unknown> = {}) => ({
  source_system: "旧社員教育進捗管理",
  encoding: "utf-8-bom",
  entity: "progress",
  columns: SAMPLE_COLUMNS.progress,
  upload_id: uploadId,
  ...extra,
});

describe("permissions and tenant isolation", () => {
  it("is admin only (teacher/student 403, anonymous 401) and hides other organisations' jobs (404)", async () => {
    const jobId = await createJob(w, progressFile([["P-" + uniq(), studentNo, "2019-08-31", "開発部", teacherNo, "", "内容", ""]]), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    for (const [method, path] of [
      ["GET", "/imports"],
      ["GET", `/imports/${jobId}`],
      ["GET", `/imports/${jobId}/items`],
      ["GET", `/imports/${jobId}/errors.csv`],
      ["POST", `/imports/${jobId}/validate`],
      ["POST", `/imports/${jobId}/rollback`],
    ] as const) {
      expect((await call(w.ctx, w.teacher, method, path)).status, `${method} ${path}`).toBe(403);
      expect((await call(w.ctx, w.student, method, path)).status, `${method} ${path}`).toBe(403);
    }
    const teacherPost = await call(w.ctx, w.teacher, "POST", "/imports", { body: body(crypto.randomUUID()) });
    expect(teacherPost.status).toBe(403);
    expectContract(teacherPost, "post", "/imports");
    const anon = await call(w.ctx, null, "GET", "/imports");
    expect(anon.status).toBe(401);
    expectContract(anon, "get", "/imports");

    for (const [method, path] of [
      ["GET", `/imports/${jobId}`],
      ["GET", `/imports/${jobId}/items`],
      ["GET", `/imports/${jobId}/errors.csv`],
      ["POST", `/imports/${jobId}/validate`],
      ["POST", `/imports/${jobId}/rollback`],
    ] as const) {
      expect((await call(w.ctx, otherAdmin, method, path)).status, `${method} ${path}`).toBe(404);
    }
    const commit = await call(w.ctx, otherAdmin, "POST", `/imports/${jobId}/commit`, { body: { backup_confirmed: true } });
    expect(commit.status).toBe(404);
    expectContract(commit, "post", "/imports/{id}/commit");
    expect((await call(w.ctx, w.admin, "GET", "/imports/not-a-uuid")).status).toBe(404);
    const list = await call(w.ctx, otherAdmin, "GET", "/imports");
    expect(list.body.items.some((j: any) => j.id === jobId)).toBe(false);
  });
});

describe("POST /imports (upload lifecycle)", () => {
  const bytes = progressFile([["X1", "E1", "2019-08-31", "開発部", "T1", "", "内容", ""]]);

  it("registers a job for a clean upload without exposing the file location", async () => {
    const uploadId = await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes, { filename: "進捗.csv" });
    const res = await call(w.ctx, w.admin, "POST", "/imports", { body: body(uploadId) });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/imports");
    expect(res.body.data).toMatchObject({ state: "uploaded", entity: "progress", filename: "進捗.csv", upload_id: uploadId, total_rows: 0, columns: expect.any(Array) });
    expect(JSON.stringify(res.body)).not.toContain("imports/");
    expect(res.headers.get("etag")).toBe(`"${res.body.data.row_version}"`);
    const due = res.body.data.columns.find((c: any) => c.field === "due_date");
    expect(due).toMatchObject({ required: true, source_header: "終了予定日", empty_count: null });
    expect(due.empty_meaning_ja).toContain("元の年月日");
  });

  it("reports unfinished, unscanned, rejected and expired uploads distinctly", async () => {
    const expect409 = async (ctx: TestContext, uploadId: string, code: string) => {
      const res = await call(ctx, w.admin, "POST", "/imports", { body: body(uploadId) });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expectContract(res, "post", "/imports");
      expect(res.body.code).toBe(code);
      return res.body;
    };
    const awaiting = await expect409(w.ctx, await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes, { state: "awaiting_upload" }), "IMPORT_UPLOAD_NOT_READY");
    expect(awaiting.message_ja).toContain("アップロードが完了していません");
    await expect409(w.ctx, await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes, { state: "awaiting_upload", expired: true }), "UPLOAD_EXPIRED");
    const scanning = await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes, { state: "scanning" });
    const pending = await expect409(w.ctx, scanning, "IMPORT_UPLOAD_NOT_READY");
    expect(pending.details).toEqual({ scanner_configured: true });
    // Without a scanner the upload never becomes clean; the message says file scanning must be configured.
    const unscanned = await expect409(noScanner, scanning, "IMPORT_UPLOAD_NOT_READY");
    expect(unscanned.message_ja).toContain("ファイル検査");
    expect(unscanned.message_ja).toContain("設定");
    expect(unscanned.details).toEqual({ scanner_configured: false });
    const blocked = await expect409(w.ctx, await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes, { state: "blocked" }), "IMPORT_UPLOAD_REJECTED");
    expect(blocked.message_ja).toContain("問題が検出");
    const rejected = await expect409(w.ctx, await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes, { state: "rejected", rejectCode: "content_mismatch" }), "IMPORT_UPLOAD_REJECTED");
    expect(rejected.message_ja).toContain("CSV");
    await expect409(w.ctx, await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes, { state: "expired" }), "UPLOAD_EXPIRED");
  });

  it("rejects uploads of another user, another purpose or another organisation (422)", async () => {
    const theirs = await insertUpload(w, other.orgId, other.admin.userId, bytes);
    const material = await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes, { purpose: "material" });
    for (const id of [theirs, crypto.randomUUID()]) {
      const res = await call(w.ctx, w.admin, "POST", "/imports", { body: body(id) });
      expect(res.status).toBe(422);
      expect(res.body.field_errors.upload_id).toContain("見つかりません");
    }
    const res = await call(w.ctx, w.admin, "POST", "/imports", { body: body(material) });
    expect(res.status).toBe(422);
    expect(res.body.field_errors.upload_id).toContain("データ移植用");
  });

  it("validates the mapping with Japanese field errors per target field", async () => {
    const uploadId = await insertUpload(w, w.org.orgId, w.org.admin.userId, bytes);
    const res = await call(w.ctx, w.admin, "POST", "/imports", {
      body: body(uploadId, { columns: { 社員番号: "employee_number", 社員ID: "employee_number", 予定: "due_date", 謎: "password" } }),
    });
    expect(res.status).toBe(422);
    expectContract(res, "post", "/imports");
    expect(res.body.code).toBe("IMPORT_MAPPING_INVALID");
    expect(res.body.field_errors["mapping.employee_number"]).toContain("複数の列");
    expect(res.body.field_errors["mapping.password"]).toContain("ありません");
    expect(res.body.field_errors["mapping.content"]).toBe("内容は必須です。対応する列を選択してください。");
    const bad = await call(w.ctx, w.admin, "POST", "/imports", { body: { ...body(uploadId), entity: "users", encoding: "latin1" } });
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors.entity).toBe("選択肢から選んでください。");
  });

  it("works with a file uploaded through POST /uploads and scanned clean", async () => {
    const file = progressFile([["U-" + uniq(), studentNo, "2019-08-31", "開発部", teacherNo, "", "内容", ""]]);
    const presign = await call(w.ctx, w.admin, "POST", "/uploads", { body: { filename: "progress.csv", content_type: "text/csv", size_bytes: file.length, purpose: "import" } });
    expect(presign.status).toBe(200);
    w.storage.clientPut(presign.body.data.object_key, file, "text/csv");
    const done = await call(w.ctx, w.admin, "POST", `/uploads/${presign.body.data.id}/complete`);
    expect(done.body.data.state).toBe("clean");
    const job = await call(w.ctx, w.admin, "POST", "/imports", { body: body(presign.body.data.id) });
    expect(job.status).toBe(200);
    const validated = await validateJob(w, job.body.data.id);
    expect(validated.body.data).toMatchObject({ total_rows: 1, new_rows: 1, error_rows: 0 });

    // No scanner: the upload stays in scanning and cannot be imported.
    const presign2 = await call(noScanner, w.admin, "POST", "/uploads", { body: { filename: "p2.csv", content_type: "text/csv", size_bytes: file.length, purpose: "import" } });
    w.storage.clientPut(presign2.body.data.object_key, file, "text/csv");
    await call(noScanner, w.admin, "POST", `/uploads/${presign2.body.data.id}/complete`);
    const refused = await call(noScanner, w.admin, "POST", "/imports", { body: body(presign2.body.data.id) });
    expect(refused.status).toBe(409);
    expect(refused.body.message_ja).toContain("ファイル検査");
  });
});

describe("dry run (POST /imports/{id}/validate)", () => {
  let jobId: string;
  const dupId = () => `D-${uniq()}`;
  let rows: string[][];

  beforeAll(async () => {
    const dup = dupId();
    rows = [
      [dup, studentNo, "2019-08-31", "開発部", teacherNo, "田中 祥司", "技術知識習得", ""],
      ["R-" + uniq(), studentNo, "2026-02-30", "開発部", teacherNo, "", "内容", "完了"],
      ["=1+1", "E-UNKNOWN", "2019年9月26日（木）", "開発部", "T-UNKNOWN", "", "内容", ""],
      [dup, studentNo, "2019-09-30", "営業部", teacherNo, "", "営業に同行", ""],
      ["R-" + uniq(), studentNo, "2019-10-01", "", teacherNo, "", "", "済"],
      ["", "", "", "", "", "", "", ""],
      ["R-" + uniq(), studentNo, "8月31日", "開発部", teacherNo, "", '=HYPERLINK("http://evil.invalid")', "たぶん完了"],
      ["R-" + uniq(), studentNo, "2019年10月29日（火）", "サポート部", teacherNo, "田中 祥二", "自社製品の使い込み、メールサポート\n（2日間）", ""],
    ];
    jobId = await createJob(w, progressFile(rows), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
  });

  it("stores per-row Japanese errors and a summary without changing business data", async () => {
    const before = await w.ctx.admin.query("SELECT count(*)::int AS n FROM app.progress_records WHERE org_id = $1", [w.org.orgId]);
    const res = await validateJob(w, jobId);
    expectContract(res, "post", "/imports/{id}/validate");
    const job = res.body.data;
    expect(job).toMatchObject({ state: "validated", total_rows: 7, blank_rows: 1, error_rows: 6, valid_rows: 1, new_rows: 1, warning_rows: 1 });
    const byRow = (r: number) => job.errors.filter((e: any) => e.row === r).map((e: any) => `${e.field}:${e.message_ja}`);
    expect(byRow(2)).toEqual([expect.stringContaining("source_record_id:旧システムのレコードID")]);
    expect(byRow(2)[0]).toContain("2・5行目");
    expect(byRow(3)).toEqual(["due_date:終了予定日「2026-02-30」は存在しない日付です。"]);
    expect(byRow(4)).toEqual([
      "employee_number:社員番号「E-UNKNOWN」の社員が未登録です。先に新入社員を移行・登録してください。",
      "teacher_number:講師番号「T-UNKNOWN」の講師が未登録です。講師を登録するか、項目の対応を修正してください。",
    ]);
    expect(byRow(6)).toEqual(["department_name:教育担当部署は必須です。", "content:内容は必須です。"]);
    expect(byRow(8).some((e: string) => e.startsWith("due_date:終了予定日「8月31日」を日付として読み取れません"))).toBe(true);
    expect(byRow(8).some((e: string) => e.startsWith("state:学習完了状態「たぶん完了」を判別できません"))).toBe(true);
    const err = job.errors.find((e: any) => e.row === 3);
    expect(err).toMatchObject({ label_ja: "終了予定日", header: "終了予定日" });
    const content = job.columns.find((c: any) => c.field === "content");
    expect(content).toMatchObject({ empty_count: 1, error_count: 1 });
    const after = await w.ctx.admin.query("SELECT count(*)::int AS n FROM app.progress_records WHERE org_id = $1", [w.org.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("previews planned values (multi-line text kept, Japanese date normalised) and pages errors", async () => {
    const planned = await items(w, jobId, "?status=create");
    expect(planned.map((i: any) => i.row)).toEqual([9]);
    expect(planned[0].values).toMatchObject({ due_date: "2019-10-29", state: "unverified", content: "自社製品の使い込み、メールサポート\n（2日間）", teacher_name_snapshot: "田中 祥二" });
    expect(planned[0].warnings[0]).toMatchObject({ field: "teacher_name", label_ja: "教育担当者" });
    expect(planned[0].warnings[0].message_ja).toContain("旧システムの名前をそのまま記録");
    const errs = await items(w, jobId, "?status=error&limit=2");
    expect(errs).toHaveLength(2);
    const pageRes = await call(w.ctx, w.admin, "GET", `/imports/${jobId}/items?status=error&limit=2`);
    expectContract(pageRes, "get", "/imports/{id}/items");
    const next = await call(w.ctx, w.admin, "GET", `/imports/${jobId}/items?status=error&limit=2&cursor=${pageRes.body.next_cursor}`);
    expect(next.body.items[0].row).toBeGreaterThan(errs[1].row);

    const first = await call(w.ctx, w.admin, "GET", `/imports/${jobId}?errors_limit=2`);
    expectContract(first, "get", "/imports/{id}");
    expect(first.body.data.errors).toHaveLength(2);
    expect(first.body.data.errors_next_cursor).toBeTruthy();
    const second = await call(w.ctx, w.admin, "GET", `/imports/${jobId}?errors_limit=2&errors_cursor=${first.body.data.errors_next_cursor}`);
    expect(second.body.data.errors[0]).not.toEqual(first.body.data.errors[0]);
    expect((await call(w.ctx, w.admin, "GET", `/imports/${jobId}?errors_limit=500`)).status).toBe(422);
  });

  it("downloads the error report as CSV with formula-injection escaping", async () => {
    const res = await call(w.ctx, w.admin, "GET", `/imports/${jobId}/errors.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = res.body as string;
    // Response.text() drops the BOM; check the raw bytes for it (Excel needs it to read UTF-8).
    const raw = await w.ctx.app.request(`/api/v1/imports/${jobId}/errors.csv`, { headers: w.admin.headers("GET") });
    expect([...new Uint8Array(await raw.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toContain('"行番号","種別","照合キー","項目","元の見出し","内容"\r\n');
    expect(text).toContain(`"4","エラー","'=1+1","社員番号","社員番号"`);
    expect(text).not.toMatch(/(^|,)"=/m);
    expect(text).toContain("警告");
  });

  it("refuses to commit while rows have errors and requires the backup confirmation", async () => {
    const noBackup = await call(w.ctx, w.admin, "POST", `/imports/${jobId}/commit`, { body: {} });
    expect(noBackup.status).toBe(422);
    expect(noBackup.body.field_errors.backup_confirmed).toBeTruthy();
    const res = await commitJob(w, jobId);
    expect(res.status).toBe(409);
    expectContract(res, "post", "/imports/{id}/commit");
    expect(res.body).toMatchObject({ code: "IMPORT_HAS_ERRORS", details: { error_rows: 6 } });
  });

  it("re-validating replaces the previous items; PATCH corrects the mapping and discards the dry run", async () => {
    await validateJob(w, jobId);
    const count = await w.ctx.admin.query("SELECT count(*)::int AS n FROM app.import_items WHERE job_id = $1", [jobId]);
    expect(count.rows[0].n).toBe(7);
    const job = (await call(w.ctx, w.admin, "GET", `/imports/${jobId}`)).body.data;
    const patchBody = { source_system: "旧社員教育進捗管理", encoding: "utf-8-bom", entity: "progress", columns: { ...SAMPLE_COLUMNS.progress, 状態: undefined }, upload_id: job.upload_id };
    delete (patchBody.columns as Record<string, unknown>)["状態"];
    const stale = await call(w.ctx, w.admin, "PATCH", `/imports/${jobId}`, { body: patchBody, ifMatch: job.row_version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const missingIfMatch = await call(w.ctx, w.admin, "PATCH", `/imports/${jobId}`, { body: patchBody });
    expect(missingIfMatch.status).toBe(400);
    const other = await call(w.ctx, w.admin, "PATCH", `/imports/${jobId}`, { body: { ...patchBody, upload_id: crypto.randomUUID() }, ifMatch: job.row_version });
    expect(other.status).toBe(422);
    const ok = await call(w.ctx, w.admin, "PATCH", `/imports/${jobId}`, { body: patchBody, ifMatch: job.row_version });
    expect(ok.status).toBe(200);
    expectContract(ok, "patch", "/imports/{id}");
    expect(ok.body.data).toMatchObject({ state: "uploaded", total_rows: 0, mapping: patchBody.columns });
    const revalidated = await validateJob(w, jobId);
    // Without the 状態 column the unknown state words are no longer errors (empty meaning: 未確認).
    expect(revalidated.body.data.errors.some((e: any) => e.field === "state")).toBe(false);
  });

  it("reports a mapped header that is missing from the file", async () => {
    const id = await createJob(w, progressFile([["Z1", studentNo, "2019-08-31", "開発部", teacherNo, "", "内容", ""]]), {
      entity: "progress",
      columns: { ...SAMPLE_COLUMNS.progress, 備考欄: "notes" },
    });
    const res = await call(w.ctx, w.admin, "POST", `/imports/${id}/validate`);
    expect(res.status).toBe(422);
    expect(res.body.field_errors["mapping.notes"]).toBe("ファイルに見出し「備考欄」の列がありません。項目の対応を修正してください。");
  });
});

describe("encodings", () => {
  it("imports a CP932 (Shift_JIS) file and rejects a mismatching declaration", async () => {
    const n = uniq();
    const text = csv([
      ["講師番号", "氏名", "ふりがな", "メール", "部署", "状態"],
      [`SJ-${n}`, "髙橋 健太", "たかはし けんた", `sj-${n}@example.invalid`, "サポート部", "有効"],
    ]);
    const bytes = cp932(text);
    const wrong = await createJob(w, bytes, { entity: "teachers", columns: SAMPLE_COLUMNS.teachers, encoding: "utf-8" });
    const mismatch = await call(w.ctx, w.admin, "POST", `/imports/${wrong}/validate`);
    expect(mismatch.status).toBe(422);
    expectContract(mismatch, "post", "/imports/{id}/validate");
    expect(mismatch.body.code).toBe("IMPORT_ENCODING_MISMATCH");
    expect(mismatch.body.message_ja).toContain("Shift_JIS（CP932）");

    const jobId = await createJob(w, bytes, { entity: "teachers", columns: SAMPLE_COLUMNS.teachers, encoding: "cp932" });
    const res = await validateJob(w, jobId);
    expect(res.body.data).toMatchObject({ detected_encoding: "cp932", new_rows: 1, error_rows: 0 });
    const [row] = await items(w, jobId);
    expect(row.values).toMatchObject({ display_name: "髙橋 健太", department_name: "サポート部" });
    expect((await commitJob(w, jobId)).body.data.state).toBe("completed");
    const u = await w.ctx.admin.query("SELECT u.display_name FROM app.teacher_profiles tp JOIN app.users u ON u.id = tp.id WHERE tp.teacher_number = $1", [`SJ-${n}`]);
    expect(u.rows[0].display_name).toBe("髙橋 健太");
  });

  it("flags a UTF-8 file declared as BOM-less as a (non-blocking) mismatch and rejects broken CSV", async () => {
    const id = await createJob(w, progressFile([["E-" + uniq(), studentNo, "2019-08-31", "開発部", teacherNo, "", "内容", ""]]), {
      entity: "progress",
      columns: SAMPLE_COLUMNS.progress,
      encoding: "utf-8",
    });
    const res = await validateJob(w, id);
    expect(res.body.data).toMatchObject({ detected_encoding: "utf-8-bom", encoding_mismatch: true, error_rows: 0 });
    const broken = await createJob(w, withBom(`${PROGRESS_HEADER.join(",")}\r\nA,"unterminated,x\r\n`), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    const bad = await call(w.ctx, w.admin, "POST", `/imports/${broken}/validate`);
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "IMPORT_CSV_INVALID", details: { line: 2 } });
    expect(bad.body.message_ja).toContain("2行目");
    const empty = await createJob(w, withBom(`${PROGRESS_HEADER.join(",")}\r\n,,,,,,,\r\n`), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    expect((await call(w.ctx, w.admin, "POST", `/imports/${empty}/validate`)).body.code).toBe("IMPORT_EMPTY");
  });

  it("responds NOT_CONFIGURED when object storage is not configured and FILE_MISSING when the object is gone", async () => {
    const jobId = await createJob(w, progressFile([["N-" + uniq(), studentNo, "2019-08-31", "開発部", teacherNo, "", "内容", ""]]), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    const res = await call(noStorage, w.admin, "POST", `/imports/${jobId}/validate`);
    expect(res.status).toBe(503);
    expectContract(res, "post", "/imports/{id}/validate");
    expect(res.body.code).toBe("NOT_CONFIGURED");
    const key = (await w.ctx.admin.query("SELECT object_key FROM app.import_jobs WHERE id = $1", [jobId])).rows[0].object_key;
    w.storage.objects.delete(key);
    const gone = await call(w.ctx, w.admin, "POST", `/imports/${jobId}/validate`);
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe("IMPORT_FILE_MISSING");
  });
});

describe("commit idempotency and history", () => {
  it("replays the same key, refuses a changed body or a second commit, and never duplicates under concurrency", async () => {
    const sid = () => `C-${uniq()}`;
    const file = progressFile([
      [sid(), studentNo, "2019-08-31", "開発部", teacherNo, "", "技術知識習得", ""],
      [sid(), studentNo, "2019-09-26", "開発部", teacherNo, "", "サーバーの構築", "完了"],
    ]);
    const jobId = await createJob(w, file, { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    expect((await call(w.ctx, w.admin, "POST", `/imports/${jobId}/commit`, { body: { backup_confirmed: true } })).body.message_ja).toContain("ドライラン");
    await validateJob(w, jobId);
    const key = crypto.randomUUID();
    const first = await commitJob(w, jobId, { key });
    expect(first.body.data).toMatchObject({ state: "completed", committed_rows: 2 });
    const replay = await commitJob(w, jobId, { key });
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(jobId);
    const changed = await commitJob(w, jobId, { key, sendInvitations: true });
    expect(changed.body.code).toBe("IDEMPOTENCY_CONFLICT");
    const again = await commitJob(w, jobId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("INVALID_STATE");
    expect((await call(w.ctx, w.admin, "POST", `/imports/${jobId}/validate`)).status).toBe(409);

    const parallel = await createJob(w, progressFile([[sid(), studentNo, "2019-10-29", "開発部", teacherNo, "", "技術知識習得", ""]]), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    await validateJob(w, parallel);
    const results = await Promise.all([commitJob(w, parallel), commitJob(w, parallel), commitJob(w, parallel)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(["IMPORT_IN_PROGRESS", "INVALID_STATE"]).toContain(r.body.code);
    const n = await w.ctx.admin.query("SELECT count(*)::int AS n FROM app.import_items i JOIN app.progress_records p ON p.id = i.entity_id WHERE i.job_id = $1", [parallel]);
    expect(n.rows[0].n).toBe(1);
  });

  it("lists the job history newest first with entity filter and cursor pagination", async () => {
    const res = await call(w.ctx, w.admin, "GET", "/imports?limit=2");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/imports");
    expect(res.body.items).toHaveLength(2);
    expect(res.body.next_cursor).toBeTruthy();
    expect(new Date(res.body.items[0].created_at) >= new Date(res.body.items[1].created_at)).toBe(true);
    const next = await call(w.ctx, w.admin, "GET", `/imports?limit=2&cursor=${res.body.next_cursor}`);
    expect(next.body.items[0].id).not.toBe(res.body.items[1].id);
    const teachers = await call(w.ctx, w.admin, "GET", "/imports?entity=teachers");
    expect(teachers.body.items.length).toBeGreaterThan(0);
    expect(teachers.body.items.every((j: any) => j.entity === "teachers")).toBe(true);
    expect((await call(w.ctx, w.admin, "GET", "/imports?entity=users")).status).toBe(422);
  });
});
