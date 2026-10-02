/** docs/08 初期上限: 10,000 rows / 10 MB — a full-size file is processed in bounded batches; larger files are rejected. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call } from "../helpers/app";
import { SAMPLE_COLUMNS, commitJob, createJob, csv, importWorld, utf8, withBom, type ImportWorld } from "../helpers/imports-fixtures";

let w: ImportWorld;
let studentNo: string;
let teacherNo: string;

beforeAll(async () => {
  w = await importWorld();
  studentNo = (await w.ctx.admin.query("SELECT employee_number FROM app.student_profiles WHERE id = $1", [w.org.student.userId])).rows[0].employee_number;
  teacherNo = (await w.ctx.admin.query("SELECT teacher_number FROM app.teacher_profiles WHERE id = $1", [w.org.teacher.userId])).rows[0].teacher_number;
});
afterAll(async () => w.ctx.close());

const HEADER = ["source_record_id", "社員番号", "終了予定日", "教育担当部署", "教育担当講師番号", "教育担当者", "内容", "状態"];
function progressRows(n: number, prefix: string): string[][] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2019, 7, 31) + (i % 365) * 86_400_000).toISOString().slice(0, 10);
    return [`${prefix}${String(i + 1).padStart(5, "0")}`, studentNo, d, i % 2 ? "開発部" : "サポート部", teacherNo, "田中 祥司", `技術知識習得 ${i + 1}`, i % 3 ? "" : "完了"];
  });
}

describe("limits", () => {
  it("validates, commits and rolls back a 10,000-row file within limits", { timeout: 180_000 }, async () => {
    const file = withBom(csv([HEADER, ...progressRows(10_000, `BIG-${Date.now()}-`)]));
    const jobId = await createJob(w, file, { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    let started = Date.now();
    const validated = await call(w.ctx, w.admin, "POST", `/imports/${jobId}/validate`);
    const validateMs = Date.now() - started;
    expect(validated.status, JSON.stringify(validated.body).slice(0, 500)).toBe(200);
    expect(validated.body.data).toMatchObject({ total_rows: 10_000, new_rows: 10_000, error_rows: 0 });

    started = Date.now();
    let res = await commitJob(w, jobId);
    // A request that hits the time budget leaves the job committing; calling again continues.
    for (let i = 0; i < 10 && res.body.data?.state === "committing"; i++) res = await commitJob(w, jobId);
    const commitMs = Date.now() - started;
    expect(res.body.data).toMatchObject({ state: "completed", committed_rows: 10_000 });
    const n = await w.ctx.admin.query("SELECT count(*)::int AS n FROM app.progress_records WHERE org_id = $1 AND source_record_id LIKE 'BIG-%'", [w.org.orgId]);
    expect(n.rows[0].n).toBe(10_000);

    started = Date.now();
    let rb = await call(w.ctx, w.admin, "POST", `/imports/${jobId}/rollback`);
    for (let i = 0; i < 10 && rb.body.data?.state !== "rolled_back"; i++) rb = await call(w.ctx, w.admin, "POST", `/imports/${jobId}/rollback`);
    const rollbackMs = Date.now() - started;
    expect(rb.body.data).toMatchObject({ state: "rolled_back", reverted_rows: 10_000 });
    w.ctx.deps.log({ msg: "import_10k_timing", validateMs, commitMs, rollbackMs });
    console.info(`10,000 rows: validate ${validateMs} ms, commit ${commitMs} ms, rollback ${rollbackMs} ms`);
    // Sanity bound for a local PostgreSQL (each phase runs in ≤200-row transactions or set-based statements).
    expect(validateMs + commitMs + rollbackMs).toBeLessThan(120_000);
  });

  it("rejects 10,001 data rows and files over 10 MB", { timeout: 60_000 }, async () => {
    const tooMany = await createJob(w, withBom(csv([HEADER, ...progressRows(10_001, "MANY-")])), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    const rows = await call(w.ctx, w.admin, "POST", `/imports/${tooMany}/validate`);
    expect(rows.status).toBe(422);
    expect(rows.body).toMatchObject({ code: "IMPORT_TOO_MANY_ROWS", details: { max_rows: 10_000 } });
    expect(rows.body.message_ja).toContain("10,000行");

    const big = utf8(`${HEADER.join(",")}\r\nX,${studentNo},2019-08-31,開発部,${teacherNo},,${"あ".repeat(3_500_000)},\r\n`);
    expect(big.length).toBeGreaterThan(10 * 1024 * 1024);
    const large = await createJob(w, big, { entity: "progress", columns: SAMPLE_COLUMNS.progress, encoding: "utf-8" });
    const res = await call(w.ctx, w.admin, "POST", `/imports/${large}/validate`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("FILE_TOO_LARGE");
    expect(res.body.message_ja).toContain("10MB");
  });
});
