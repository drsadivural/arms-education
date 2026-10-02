/**
 * End-to-end migration of the sample legacy exports in migration/ (UTF-8 with BOM, Japanese headers):
 * 講師 → クラス → 新入社員 → 教育進捗, re-import without duplicates, update, rollback and rollback refusal.
 * The sample e-mail addresses are unique across the test database, so only this file imports them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { SAMPLE_COLUMNS, commitJob, createJob, csv, importAll, importWorld, items, sampleFile, validateJob, withBom, type ImportWorld } from "../helpers/imports-fixtures";

let w: ImportWorld;
const jobs: Record<string, string> = {};

beforeAll(async () => {
  w = await importWorld();
});
afterAll(async () => w.ctx.close());

const q = (text: string, values: unknown[]) => w.ctx.admin.query(text, values).then((r) => r.rows);

describe("sample teachers.csv", () => {
  it("dry run: 1 new teacher, same-name teacher is a warning (never merged), empty meanings per column", async () => {
    const jobId = await createJob(w, sampleFile("teachers"), { entity: "teachers", columns: SAMPLE_COLUMNS.teachers });
    jobs.teachers = jobId;
    const res = await validateJob(w, jobId);
    expectContract(res, "post", "/imports/{id}/validate");
    const job = res.body.data;
    expect(job).toMatchObject({ state: "validated", total_rows: 1, new_rows: 1, update_rows: 0, error_rows: 0, valid_rows: 1, warning_rows: 1 });
    expect(job.detected_encoding).toBe("utf-8-bom");
    expect(job.encoding_mismatch).toBe(false);
    expect(job.headers).toEqual(["講師番号", "氏名", "ふりがな", "メール", "部署", "状態"]);
    const email = job.columns.find((c: any) => c.field === "email");
    expect(email).toMatchObject({ required: true, source_header: "メール", empty_count: 0, error_count: 0 });
    expect(email.empty_meaning_ja).toContain("ログインID");
    const [row] = await items(w, jobId);
    expect(row).toMatchObject({ row: 2, action: "create", key: "T001" });
    expect(row.values).toMatchObject({ teacher_number: "T001", display_name: "田中 祥司", email: "tanaka@example.invalid", active: true });
    expect(row.warnings[0].message_ja).toContain("同姓同名");
  });

  it("commit creates the account through the invitation saga without sending (招待メール送信待ち)", async () => {
    const res = await commitJob(w, jobs.teachers as string);
    expect(res.status).toBe(200);
    expectContract(res, "post", "/imports/{id}/commit");
    expect(res.body.data).toMatchObject({ state: "completed", committed_rows: 1, options: { send_invitations: false }, invitations: { sent: 0, failed: 0, not_sent: 1 } });
    expect(w.ctx.auth.invitesSent).toHaveLength(0);
    const [t] = await q(
      `SELECT tp.id, tp.teacher_number, m.active, u.email, (SELECT state FROM app.invitation_jobs j WHERE j.auth_user_id = tp.id) AS invitation
       FROM app.teacher_profiles tp JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id JOIN app.users u ON u.id = tp.id
       WHERE tp.org_id = $1 AND tp.teacher_number = 'T001'`,
      [w.org.orgId],
    );
    expect(t).toMatchObject({ active: true, email: "tanaka@example.invalid", invitation: "profile_created" });
    // The pre-existing 田中 祥司 (other teacher number) is untouched: two different people.
    const same = await q("SELECT count(*)::int AS n FROM app.teacher_profiles tp JOIN app.users u ON u.id = tp.id WHERE tp.org_id = $1 AND u.display_name = '田中 祥司'", [w.org.orgId]);
    expect(same[0].n).toBe(2);
    const audit = await q("SELECT event_type, payload FROM app.audit_events WHERE org_id = $1 AND entity_id = $2", [w.org.orgId, t.id]);
    expect(audit[0]).toMatchObject({ event_type: "teacher.created", payload: { source: "import", import_job_id: jobs.teachers, row: 2 } });
    const jobAudit = await q("SELECT event_type FROM app.audit_events WHERE org_id = $1 AND entity_id = $2 ORDER BY created_at, event_type", [w.org.orgId, jobs.teachers]);
    expect(jobAudit.map((a: any) => a.event_type)).toEqual(expect.arrayContaining(["import.created", "import.validated", "import.commit_started", "import.completed"]));
    // 講師管理 shows the account as waiting for the invitation e-mail; the admin can send it from there.
    const teachers = await call(w.ctx, w.admin, "GET", "/teachers?q=T001");
    expect(teachers.body.items[0]).toMatchObject({ teacher_number: "T001", invitation_state: "profile_created" });
    const resend = await call(w.ctx, w.admin, "POST", `/settings/users/${t.id}/resend-invite`);
    expect(resend.status).toBe(200);
    expect(w.ctx.auth.invitesSent.map((i) => i.email)).toEqual(["tanaka@example.invalid"]);
  });
});

describe("sample classrooms.csv / students.csv", () => {
  it("creates the classroom (クラス番号 recorded) and the employee in it with the classroom period as training dates", async () => {
    jobs.classrooms = (await importAll(w, sampleFile("classrooms"), { entity: "classrooms", columns: SAMPLE_COLUMNS.classrooms })).jobId;
    const [k] = await q(
      "SELECT c.id, c.name, c.capacity, to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on FROM app.import_classroom_keys k JOIN app.classrooms c ON c.org_id = k.org_id AND c.id = k.classroom_id WHERE k.org_id = $1 AND k.classroom_code = 'C001'",
      [w.org.orgId],
    );
    expect(k).toMatchObject({ name: "2026年度 新入社員Aクラス", capacity: 30, starts_on: "2026-10-01" });

    const students = await importAll(w, sampleFile("students"), { entity: "students", columns: SAMPLE_COLUMNS.students });
    jobs.students = students.jobId;
    expect(students.validated.body.data.warning_rows).toBe(1); // same-name 和田 一夫 with a different employee number
    const [s] = await q(
      `SELECT sp.employee_number, sp.classroom_id, sp.active, to_char(sp.training_starts_on, 'YYYY-MM-DD') AS s, to_char(sp.training_due_on, 'YYYY-MM-DD') AS d,
         tp.teacher_number FROM app.student_profiles sp JOIN app.teacher_profiles tp ON tp.org_id = sp.org_id AND tp.id = sp.teacher_id
       WHERE sp.org_id = $1 AND sp.employee_number = 'E001'`,
      [w.org.orgId],
    );
    expect(s).toMatchObject({ classroom_id: k.id, active: true, s: "2026-10-01", d: "2026-12-31", teacher_number: "T001" });
  });
});

describe("sample progress.csv", () => {
  it("keeps 2019 dates as written and imports a missing completion state as 未確認", async () => {
    const { jobId, validated } = await importAll(w, sampleFile("progress"), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    jobs.progress = jobId;
    expect(validated.body.data).toMatchObject({ total_rows: 1, new_rows: 1, error_rows: 0 });
    const rows = await q(
      `SELECT to_char(due_date, 'YYYY-MM-DD') AS due, department_name, teacher_name_snapshot, content, state, source_system, row_version
       FROM app.progress_records WHERE org_id = $1 AND source_record_id = 'OLD0001'`,
      [w.org.orgId],
    );
    expect(rows).toEqual([
      { due: "2019-08-31", department_name: "開発部", teacher_name_snapshot: "田中 祥司", content: "技術知識習得・プログラム言語習得", state: "unverified", source_system: "旧社員教育進捗管理", row_version: 1 },
    ]);
  });

  it("re-importing the same source keys does not duplicate: unchanged rows are skipped", async () => {
    const jobId = await createJob(w, sampleFile("progress"), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    const res = await validateJob(w, jobId);
    expect(res.body.data).toMatchObject({ total_rows: 1, new_rows: 0, update_rows: 0, skip_rows: 1 });
    const done = await commitJob(w, jobId);
    expect(done.body.data).toMatchObject({ state: "completed", committed_rows: 0 });
    const n = await q("SELECT count(*)::int AS n, min(to_char(due_date, 'YYYY-MM-DD')) AS due FROM app.progress_records WHERE org_id = $1 AND source_record_id = 'OLD0001'", [w.org.orgId]);
    expect(n[0]).toEqual({ n: 1, due: "2019-08-31" });
  });

  const header = ["source_record_id", "社員番号", "終了予定日", "教育担当部署", "教育担当講師番号", "教育担当者", "内容", "状態"];
  const changed = () =>
    withBom(
      csv([
        header,
        ["OLD0001", "E001", "2019-08-31", "開発部", "T001", "田中 祥司", "技術知識習得・プログラム言語習得（改訂）", "未確認"],
        ["OLD0002", "E001", "2019年9月26日（木）", "開発部", "T001", "田中 祥司", "サーバーの構築、製品動作試験", "完了"],
      ]),
    );

  it("a changed file updates (row_version checked) and adds new rows; rollback restores and deletes them", async () => {
    const jobId = await createJob(w, changed(), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    const res = await validateJob(w, jobId);
    expect(res.body.data).toMatchObject({ total_rows: 2, new_rows: 1, update_rows: 1, skip_rows: 0 });
    const preview = await items(w, jobId, "?status=update");
    expect(preview).toHaveLength(1);
    expectContract({ status: 200, body: { items: preview, next_cursor: null, checked_at: new Date().toISOString() } }, "get", "/imports/{id}/items");
    expect(preview[0]).toMatchObject({ row: 2, action: "update", changed_fields: ["content"] });
    expect(preview[0].before.content).toBe("技術知識習得・プログラム言語習得");
    expect((await commitJob(w, jobId)).body.data).toMatchObject({ state: "completed", committed_rows: 2 });
    const after = await q("SELECT source_record_id, content, state, row_version, to_char(due_date, 'YYYY-MM-DD') AS due FROM app.progress_records WHERE org_id = $1 ORDER BY source_record_id", [w.org.orgId]);
    expect(after).toEqual([
      { source_record_id: "OLD0001", content: "技術知識習得・プログラム言語習得（改訂）", state: "unverified", row_version: 2, due: "2019-08-31" },
      { source_record_id: "OLD0002", content: "サーバーの構築、製品動作試験", state: "completed", row_version: 1, due: "2019-09-26" },
    ]);

    const rollback = await call(w.ctx, w.admin, "POST", `/imports/${jobId}/rollback`);
    expect(rollback.status).toBe(200);
    expectContract(rollback, "post", "/imports/{id}/rollback");
    expect(rollback.body.data).toMatchObject({ state: "rolled_back", reverted_rows: 2, manual_review_rows: 0, rollback_started: true });
    const restored = await q("SELECT source_record_id, content FROM app.progress_records WHERE org_id = $1 ORDER BY source_record_id", [w.org.orgId]);
    expect(restored).toEqual([{ source_record_id: "OLD0001", content: "技術知識習得・プログラム言語習得" }]);
    const audit = await q("SELECT count(*)::int AS n FROM app.audit_events WHERE org_id = $1 AND event_type = 'progress_record.deleted' AND payload->>'import_job_id' = $2", [w.org.orgId, jobId]);
    expect(audit[0].n).toBe(1);
    // A rolled-back job cannot be committed again.
    const again = await commitJob(w, jobId);
    expect(again.status).toBe(409);
  });

  it("rollback refuses rows edited after the import and lists them as 手動照合が必要", async () => {
    const jobId = await createJob(w, changed(), { entity: "progress", columns: SAMPLE_COLUMNS.progress });
    await validateJob(w, jobId);
    expect((await commitJob(w, jobId)).body.data.state).toBe("completed");
    // An admin edits OLD0001 in 社員教育進捗管理 after the import.
    await w.ctx.admin.query("UPDATE app.progress_records SET content = '講師が修正した内容', row_version = row_version + 1 WHERE org_id = $1 AND source_record_id = 'OLD0001'", [w.org.orgId]);
    const key = crypto.randomUUID();
    const res = await call(w.ctx, w.admin, "POST", `/imports/${jobId}/rollback`, { idempotencyKey: key });
    expect(res.body.data).toMatchObject({ state: "rolled_back", reverted_rows: 1, manual_review_rows: 1 });
    const manual = await items(w, jobId, "?status=manual");
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ row: 2, rollback_state: "manual" });
    expect(manual[0].rollback_message_ja).toContain("手動で照合");
    const kept = await q("SELECT content FROM app.progress_records WHERE org_id = $1 AND source_record_id = 'OLD0001'", [w.org.orgId]);
    expect(kept[0].content).toBe("講師が修正した内容");
    // Same key replays the result; a new key on a rolled-back job is refused.
    const replay = await call(w.ctx, w.admin, "POST", `/imports/${jobId}/rollback`, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect((await call(w.ctx, w.admin, "POST", `/imports/${jobId}/rollback`)).status).toBe(409);
    const report = await call(w.ctx, w.admin, "GET", `/imports/${jobId}/errors.csv`);
    expect(report.body).toContain("手動照合が必要");
  });
});

describe("rolling back imported people", () => {
  it("stops the employee's account instead of deleting it; the teacher who is a primary teacher needs manual reconciliation", async () => {
    const res = await call(w.ctx, w.admin, "POST", `/imports/${jobs.students}/rollback`);
    expect(res.body.data).toMatchObject({ state: "rolled_back", reverted_rows: 1, manual_review_rows: 0 });
    const [s] = await q(
      `SELECT sp.id, sp.active, m.active AS membership_active, u.email FROM app.student_profiles sp
       JOIN app.memberships m ON m.org_id = sp.org_id AND m.id = sp.id JOIN app.users u ON u.id = sp.id
       WHERE sp.org_id = $1 AND sp.employee_number = 'E001'`,
      [w.org.orgId],
    );
    expect(s).toMatchObject({ active: false, membership_active: false, email: "wada@example.invalid" });
    expect([...w.ctx.auth.users.values()].find((u) => u.userId === s.id)?.banned).toBe(true);
    const [row] = await items(w, jobs.students as string);
    expect(row.rollback_message_ja).toContain("削除せず停止");

    const teachers = await call(w.ctx, w.admin, "POST", `/imports/${jobs.teachers}/rollback`);
    expect(teachers.body.data).toMatchObject({ state: "rolled_back", reverted_rows: 0, manual_review_rows: 1 });
    const [t] = await items(w, jobs.teachers as string);
    expect(t.rollback_message_ja).toContain("主担当");
    const active = await q("SELECT m.active FROM app.teacher_profiles tp JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id WHERE tp.org_id = $1 AND tp.teacher_number = 'T001'", [w.org.orgId]);
    expect(active[0].active).toBe(true);
  });
});
