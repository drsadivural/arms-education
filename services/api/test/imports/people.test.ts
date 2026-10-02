/**
 * Imported teachers / new employees: accounts through the invitation saga (optional invitation e-mail), resumable
 * commit after an Auth provider outage, conflicts detected at commit, updates by number, classroom seats.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { SAMPLE_COLUMNS, commitJob, createJob, csv, importAll, importWorld, items, uniq, validateJob, withBom, type ImportWorld } from "../helpers/imports-fixtures";
import { ApiError } from "../../src/http/errors";

let w: ImportWorld;
beforeAll(async () => {
  w = await importWorld();
});
afterAll(async () => w.ctx.close());

const TEACHER_HEADER = ["講師番号", "氏名", "ふりがな", "メール", "部署", "状態"];
const teacherFile = (rows: string[][]) => withBom(csv([TEACHER_HEADER, ...rows]));
const teacherRow = (n: string, extra: Partial<Record<"name" | "dept" | "state" | "email", string>> = {}) => [
  `T-${n}`,
  extra.name ?? `講師 ${n}`,
  "こうし",
  extra.email ?? `t-${n}@example.invalid`,
  extra.dept ?? "開発部",
  extra.state ?? "有効",
];
const q = (text: string, values: unknown[]) => w.ctx.admin.query(text, values).then((r) => r.rows);

describe("teachers", () => {
  it("sends invitations only when requested; inactive teachers are registered without one", async () => {
    const a = uniq();
    const b = uniq();
    const { committed } = await importAll(w, teacherFile([teacherRow(a), teacherRow(b, { state: "無効" })]), { entity: "teachers", columns: SAMPLE_COLUMNS.teachers }, { sendInvitations: true });
    expect(committed.body.data).toMatchObject({ committed_rows: 2, options: { send_invitations: true }, invitations: { sent: 1, failed: 0, not_sent: 1 } });
    expect(w.ctx.auth.invitesSent.map((i) => i.email)).toContain(`t-${a}@example.invalid`);
    expect(w.ctx.auth.invitesSent.map((i) => i.email)).not.toContain(`t-${b}@example.invalid`);
    const rows = await q(
      "SELECT tp.teacher_number, m.active FROM app.teacher_profiles tp JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id WHERE tp.teacher_number = ANY($1) ORDER BY tp.teacher_number",
      [[`T-${a}`, `T-${b}`]],
    );
    expect(rows.map((r: any) => r.active).sort()).toEqual([false, true]);
  });

  it("resumes an interrupted commit after an Auth provider outage without creating accounts twice", async () => {
    const ns = [uniq(), uniq(), uniq()];
    const jobId = await createJob(w, teacherFile(ns.map((n) => teacherRow(n))), { entity: "teachers", columns: SAMPLE_COLUMNS.teachers });
    await validateJob(w, jobId);
    const original = w.ctx.auth.adminCreateUser.bind(w.ctx.auth);
    let calls = 0;
    w.ctx.auth.adminCreateUser = async (email: string) => {
      calls++;
      if (calls === 2) throw new ApiError("AUTH_PROVIDER_UNAVAILABLE");
      return original(email);
    };
    try {
      const failed = await commitJob(w, jobId);
      expect(failed.status).toBe(200);
      expectContract(failed, "post", "/imports/{id}/commit");
      expect(failed.body.data).toMatchObject({ state: "failed", committed_rows: 1, failure: { code: "AUTH_PROVIDER_UNAVAILABLE", from_row: 3, to_row: 3, row: 3 } });
      expect(failed.body.data.failure.message_ja).toContain("認証サービス");
    } finally {
      w.ctx.auth.adminCreateUser = original;
    }
    const usersBefore = w.ctx.auth.users.size;
    const resumed = await commitJob(w, jobId);
    expect(resumed.body.data).toMatchObject({ state: "completed", committed_rows: 3, failure: null });
    expect(w.ctx.auth.users.size).toBe(usersBefore + 2);
    const count = await q("SELECT count(*)::int AS n FROM app.teacher_profiles WHERE teacher_number = ANY($1)", [ns.map((n) => `T-${n}`)]);
    expect(count[0].n).toBe(3);
    const audit = await q("SELECT event_type FROM app.audit_events WHERE entity_id = $1 AND event_type LIKE 'import.commit%' ORDER BY created_at", [jobId]);
    expect(audit.map((r: any) => r.event_type)).toEqual(["import.commit_started", "import.commit_failed", "import.commit_resumed"]);
  });

  it("reports a row whose e-mail was registered after the dry run as a conflict and finishes the rest", async () => {
    const [a, b] = [uniq(), uniq()];
    const jobId = await createJob(w, teacherFile([teacherRow(a), teacherRow(b)]), { entity: "teachers", columns: SAMPLE_COLUMNS.teachers });
    await validateJob(w, jobId);
    await w.ctx.admin.query("INSERT INTO app.users(id, display_name, email) VALUES (gen_random_uuid(), '別組織の人', $1)", [`t-${b}@example.invalid`]);
    const res = await commitJob(w, jobId);
    expect(res.body.data).toMatchObject({ state: "completed", committed_rows: 1, conflict_rows: 1 });
    const [conflict] = await items(w, jobId, "?status=conflict");
    expect(conflict).toMatchObject({ row: 3, commit_state: "conflict" });
    expect(conflict.commit_message_ja).toContain("ドライランの後");
    const report = await call(w.ctx, w.admin, "GET", `/imports/${jobId}/errors.csv`);
    expect(report.body).toContain("確定時の競合");
  });

  it("updates registered teachers by number, refuses e-mail/state changes, and keeps same-name people apart", async () => {
    const n = uniq();
    await importAll(w, teacherFile([teacherRow(n)]), { entity: "teachers", columns: SAMPLE_COLUMNS.teachers });
    const other = uniq();
    const jobId = await createJob(
      w,
      teacherFile([
        teacherRow(n, { dept: "営業部", name: `講師 ${n}（改姓）` }),
        teacherRow(other, { name: `講師 ${n}（改姓）` }),
        teacherRow(n === other ? "x" : uniq(), { email: `t-${n}@example.invalid` }),
      ]),
      { entity: "teachers", columns: SAMPLE_COLUMNS.teachers },
    );
    const res = await validateJob(w, jobId);
    expect(res.body.data).toMatchObject({ update_rows: 1, new_rows: 1, error_rows: 1 });
    const all = await items(w, jobId);
    expect(all[0]).toMatchObject({ action: "update", changed_fields: ["display_name", "department_name"] });
    expect(all[1].warnings[0].message_ja).toContain("同姓同名");
    // A new teacher number with the e-mail of a registered account is never joined to that account.
    expect(all[2].errors[0].message_ja).toContain("既に別のアカウントで使われています");

    const emailChange = await createJob(w, teacherFile([teacherRow(n, { email: `changed-${n}@example.invalid`, state: "無効" })]), { entity: "teachers", columns: SAMPLE_COLUMNS.teachers });
    const refused = await validateJob(w, emailChange);
    expect(refused.body.data.errors.map((e: any) => e.field)).toEqual(["email", "active"]);
    expect(refused.body.data.errors[0].message_ja).toContain("ログインID");
  });
});

describe("classrooms and new employees", () => {
  it("assigns employees to imported classrooms within capacity and validates classroom/teacher pairs", async () => {
    const t = uniq();
    await importAll(w, teacherFile([teacherRow(t)]), { entity: "teachers", columns: SAMPLE_COLUMNS.teachers });
    const code = `C-${uniq()}`;
    const classroomHeader = ["クラス番号", "名称", "定員", "開始日", "終了日", "主担当講師番号"];
    await importAll(w, withBom(csv([classroomHeader, [code, `小さなクラス ${code}`, "1", "2026年10月1日", "2026/12/31", `T-${t}`]])), {
      entity: "classrooms",
      columns: SAMPLE_COLUMNS.classrooms,
    });
    const badClass = await createJob(
      w,
      withBom(csv([classroomHeader, [`C-${uniq()}`, "定員エラー", "0", "2026-12-31", "2026-10-01", "T-NONE"]])),
      { entity: "classrooms", columns: SAMPLE_COLUMNS.classrooms },
    );
    const classErrors = (await validateJob(w, badClass)).body.data.errors.map((e: any) => e.field);
    expect(classErrors).toEqual(["capacity", "ends_on", "primary_teacher_number"]);

    const header = ["社員番号", "氏名", "ふりがな", "メール", "部署", "入社日", "クラス番号", "担当講師番号"];
    const [e1, e2, e3] = [uniq(), uniq(), uniq()];
    const otherTeacherNo = (await q("SELECT teacher_number FROM app.teacher_profiles WHERE id = $1", [w.org.otherTeacher.userId]))[0].teacher_number;
    const jobId = await createJob(
      w,
      withBom(
        csv([
          header,
          [`E-${e1}`, "和田 一夫", "わだ かずお", `e-${e1}@example.invalid`, "開発部", "2026-10-01", code, `T-${t}`],
          [`E-${e2}`, "高橋 健太", "たかはし けんた", `e-${e2}@example.invalid`, "サポート部", "2026-10-01", code, `T-${t}`],
          [`E-${e3}`, "加藤 美咲", "かとう みさき", `e-${e3}@example.invalid`, "営業部", "2026-10-01", code, otherTeacherNo],
          [`E-${uniq()}`, "存在しないクラス", "", `x-${uniq()}@example.invalid`, "営業部", "2026-10-01", "C-NONE", `T-${t}`],
        ]),
      ),
      { entity: "students", columns: SAMPLE_COLUMNS.students },
    );
    const res = await validateJob(w, jobId);
    const errs = res.body.data.errors.map((e: any) => `${e.row}:${e.field}`);
    expect(errs).toEqual(["3:classroom_code", "4:teacher_number", "5:classroom_code"]);
    expect(res.body.data.errors[0].message_ja).toContain("定員（1名）を超えます");
    expect(res.body.data.errors[1].message_ja).toContain("担当ではありません");
    // 和田 一夫 / 高橋 健太 / 加藤 美咲 also exist in the seeded organisation with other employee numbers: warnings, not merges.
    expect(res.body.data.warning_rows).toBe(3);
    expect((await items(w, jobId))[0].warnings[0].message_ja).toContain("社員番号が異なるため別人として登録します");
  });

  it("updates an employee by number and refuses classroom changes (クラス移動 is a separate operation)", async () => {
    const t = uniq();
    await importAll(w, teacherFile([teacherRow(t)]), { entity: "teachers", columns: SAMPLE_COLUMNS.teachers });
    const [c1, c2] = [`C-${uniq()}`, `C-${uniq()}`];
    const classroomHeader = ["クラス番号", "名称", "定員", "開始日", "終了日", "主担当講師番号"];
    await importAll(
      w,
      withBom(csv([classroomHeader, [c1, `A ${c1}`, "30", "2026-10-01", "2026-12-31", `T-${t}`], [c2, `B ${c2}`, "30", "2026-10-01", "2026-12-31", `T-${t}`]])),
      { entity: "classrooms", columns: SAMPLE_COLUMNS.classrooms },
    );
    const header = ["社員番号", "氏名", "ふりがな", "メール", "部署", "入社日", "クラス番号", "担当講師番号"];
    const e = uniq();
    const row = (dept: string, classroom: string) => [`E-${e}`, `社員 ${e}`, "しゃいん", `e-${e}@example.invalid`, dept, "2026-10-01", classroom, `T-${t}`];
    await importAll(w, withBom(csv([header, row("開発部", c1)])), { entity: "students", columns: SAMPLE_COLUMNS.students });
    const update = await importAll(w, withBom(csv([header, row("営業部", c1)])), { entity: "students", columns: SAMPLE_COLUMNS.students });
    expect(update.validated.body.data).toMatchObject({ update_rows: 1 });
    const [s] = await q("SELECT department_name, row_version FROM app.student_profiles WHERE employee_number = $1", [`E-${e}`]);
    expect(s).toMatchObject({ department_name: "営業部", row_version: 2 });
    const move = await createJob(w, withBom(csv([header, row("営業部", c2)])), { entity: "students", columns: SAMPLE_COLUMNS.students });
    const refused = await validateJob(w, move);
    expect(refused.body.data.errors[0].message_ja).toContain("クラス移動");
    // Rolling back the update restores the previous department (the profile was not edited since).
    const rolled = await call(w.ctx, w.admin, "POST", `/imports/${update.jobId}/rollback`);
    expect(rolled.body.data).toMatchObject({ state: "rolled_back", reverted_rows: 1 });
    const [restored] = await q("SELECT department_name FROM app.student_profiles WHERE employee_number = $1", [`E-${e}`]);
    expect(restored.department_name).toBe("開発部");
  });
});
