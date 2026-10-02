import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { createTeacher } from "../helpers/fixtures";
import { buildProgram, enrollStudent } from "../helpers/learning-fixtures";
import { learningWorld, type LearningWorld } from "../helpers/learning-setup";

let w: LearningWorld;
const R: Record<string, string> = {};

async function record(studentId: string, teacherId: string, teacherName: string, dueDate: string, content: string, opts: { department?: string; state?: string } = {}) {
  const { rows } = await w.ctx.admin.query(
    `INSERT INTO app.progress_records(org_id, student_id, teacher_id, department_name, teacher_name_snapshot, due_date, content, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [w.org.orgId, studentId, teacherId, opts.department ?? "開発部", teacherName, dueDate, content, opts.state ?? "in_progress"],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  w = await learningWorld();
  const { org } = w;
  R.r1 = await record(org.student.userId, org.teacher.userId, "田中 祥司", "2026-10-01", "技術知識習得・プログラム言語習得");
  R.r2 = await record(org.student2.userId, org.teacher.userId, "田中 祥司", "2026-10-01", "自社製品の使い込み・メールサポート", { department: "サポート部", state: "completed" });
  R.r3 = await record(org.otherStudent.userId, org.otherTeacher.userId, "別府 悦子", "2026-10-05", "営業同行・提案書の作成", { department: "営業部" });
  R.r4 = await record(org.otherStudent.userId, org.teacher.userId, "田中 祥司", "2026-11-02", "サーバーの構築、製品動作試験");
  R.r5 = await record(org.student.userId, org.teacher.userId, "田中 祥司", "2019-08-31", "技術知識習得", { state: "unverified" });
  // 和田 一夫 has a 50 % complete enrollment: records show the student's current progress.
  const b = await buildProgram(w.ctx.admin, org.orgId, [{ materials: [{ kind: "link" }] }, { materials: [{ kind: "link" }] }]);
  await enrollStudent(w.ctx.admin, org.orgId, org.student.userId, b.versionId);
  await call(w.ctx, w.student, "POST", `/materials/${b.units[0]!.materials[0]!.id}/receipt`);
});
afterAll(async () => w.ctx.close());

const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

describe("GET /progress-records", () => {
  it("lists the legacy columns ordered by 終了予定日 with the student's current progress", async () => {
    const res = await call(w.ctx, w.admin, "GET", "/progress-records?month=2026-10");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/progress-records");
    expect(ids(res.body).sort()).toEqual([R.r1, R.r2, R.r3].sort());
    expect(res.body.items.map((i: { due_date: string }) => i.due_date)).toEqual(["2026-10-01", "2026-10-01", "2026-10-05"]);
    const r1 = res.body.items.find((i: { id: string }) => i.id === R.r1);
    expect(r1).toMatchObject({
      due_date: "2026-10-01",
      student_name: "和田 一夫",
      department_name: "開発部",
      teacher_name: "田中 祥司",
      content: "技術知識習得・プログラム言語習得",
      progress_percent: 50,
    });
    const r3 = res.body.items.find((i: { id: string }) => i.id === R.r3);
    expect(r3.progress_percent).toBeNull();
    const legacy = await call(w.ctx, w.admin, "GET", "/progress-records?month=2019-08");
    expect(legacy.body.items[0]).toMatchObject({ id: R.r5, due_date: "2019-08-31", state: "unverified" });
  });

  it("filters by department, teacher, classroom, status, free text and date range", async () => {
    const q = async (qs: string) => ids((await call(w.ctx, w.admin, "GET", `/progress-records?${qs}`)).body).sort();
    expect(await q(`department=${encodeURIComponent("営業部")}`)).toEqual([R.r3]);
    expect(await q(`teacher_id=${w.org.otherTeacher.userId}`)).toEqual([R.r3]);
    expect(await q(`classroom_id=${w.org.otherClassroomId}`)).toEqual([R.r3, R.r4].sort());
    expect(await q("status=completed")).toEqual([R.r2]);
    expect(await q(`q=${encodeURIComponent("加藤")}`)).toEqual([R.r3, R.r4].sort());
    expect(await q(`q=${encodeURIComponent("サーバー")}`)).toEqual([R.r4]);
    expect(await q("from=2026-10-02&to=2026-11-30")).toEqual([R.r3, R.r4].sort());
    expect(await q(`q=${encodeURIComponent("100%_")}`)).toEqual([]);
    const bad = await call(w.ctx, w.admin, "GET", "/progress-records?month=2026-13&status=late");
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors.month).toBe("YYYY-MM形式で指定してください。");
    expect(bad.body.field_errors.status).toBeTruthy();
  });

  it("pages with a keyset cursor without gaps or duplicates", async () => {
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: { id: string }[]; next_cursor: string | null } } = await call(w.ctx, w.admin, "GET", `/progress-records?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      all.push(...ids(res.body));
      cursor = res.body.next_cursor;
    } while (cursor);
    expect(all.sort()).toEqual(Object.values(R).sort());
  });

  it("derives 期限超過 from the JST date, not the UTC date", async () => {
    w.ctx.clock.now = new Date("2026-10-01T14:59:00Z"); // 2026-10-01 23:59 JST
    let res = await call(w.ctx, w.admin, "GET", "/progress-records?month=2026-10");
    expect(res.body.items.find((i: { id: string }) => i.id === R.r1).overdue).toBe(false);
    expect(ids((await call(w.ctx, w.admin, "GET", "/progress-records?status=overdue&month=2026-10")).body)).toEqual([]);
    w.ctx.clock.now = new Date("2026-10-01T15:01:00Z"); // 2026-10-02 00:01 JST, still 2026-10-01 in UTC
    res = await call(w.ctx, w.admin, "GET", "/progress-records?month=2026-10");
    expect(res.body.items.find((i: { id: string }) => i.id === R.r1).overdue).toBe(true);
    expect(res.body.items.find((i: { id: string }) => i.id === R.r2).overdue).toBe(false); // completed is never overdue
    expect(ids((await call(w.ctx, w.admin, "GET", "/progress-records?status=overdue&month=2026-10")).body)).toEqual([R.r1]);
    w.ctx.clock.now = null;
  });

  it("limits teachers to records of their students or where they are 教育担当者", async () => {
    const mine = await call(w.ctx, w.teacher, "GET", "/progress-records");
    expect(ids(mine.body).sort()).toEqual([R.r1, R.r2, R.r4, R.r5].sort());
    const theirs = await call(w.ctx, w.otherTeacher, "GET", "/progress-records");
    expect(ids(theirs.body).sort()).toEqual([R.r3, R.r4].sort());
    expect((await call(w.ctx, w.student, "GET", "/progress-records")).status).toBe(403);
    expect((await call(w.ctx, null, "GET", "/progress-records")).status).toBe(401);
  });
});

describe("POST /progress-records", () => {
  it("creates a legacy record with name snapshots (admin)", async () => {
    const res = await call(w.ctx, w.admin, "POST", "/progress-records", {
      body: { student_id: w.org.student.userId, teacher_id: w.org.teacher.userId, department_name: "開発部", due_date: "2026-10-30", content: "サーバーの構築、製品動作試験", state: "not_started" },
    });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/progress-records");
    expect(res.body.data).toMatchObject({ teacher_name: "田中 祥司", student_name: "和田 一夫", notes: "", overdue: false, row_version: 1 });
    const snap = await w.ctx.admin.query("SELECT teacher_name_snapshot, created_by FROM app.progress_records WHERE id = $1", [res.body.data.id]);
    expect(snap.rows[0]).toEqual({ teacher_name_snapshot: "田中 祥司", created_by: w.org.admin.userId });
  });

  it("validates input in Japanese and enforces teacher scope", async () => {
    const bad = await call(w.ctx, w.admin, "POST", "/progress-records", {
      body: { student_id: w.org.student.userId, teacher_id: w.org.teacher.userId, department_name: "", due_date: "2026-02-30", content: "", state: "done" },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors).toMatchObject({ department_name: "必須項目です。", content: "必須項目です。", state: "選択肢から選んでください。" });
    expect(bad.body.field_errors.due_date).toContain("日付");
    const unknown = await call(w.ctx, w.admin, "POST", "/progress-records", {
      body: { student_id: crypto.randomUUID(), teacher_id: w.org.teacher.userId, department_name: "開発部", due_date: "2026-10-30", content: "x", state: "not_started" },
    });
    expect(unknown.body.field_errors.student_id).toBe("新入社員が見つかりません。");
    const notTeacher = await call(w.ctx, w.admin, "POST", "/progress-records", {
      body: { student_id: w.org.student.userId, teacher_id: w.org.student2.userId, department_name: "開発部", due_date: "2026-10-30", content: "x", state: "not_started" },
    });
    expect(notTeacher.body.field_errors.teacher_id).toBe("講師が見つかりません。");
    const retired = await createTeacher(w.ctx.admin, w.org.orgId, { displayName: "退職 講師", active: false });
    const inactive = await call(w.ctx, w.admin, "POST", "/progress-records", {
      body: { student_id: w.org.student.userId, teacher_id: retired.userId, department_name: "開発部", due_date: "2026-10-30", content: "x", state: "not_started" },
    });
    expect(inactive.body.code).toBe("TEACHER_INACTIVE");

    const own = await call(w.ctx, w.teacher, "POST", "/progress-records", {
      body: { student_id: w.org.student2.userId, teacher_id: w.org.teacher.userId, department_name: "サポート部", due_date: "2026-10-29", content: "技術知識習得", state: "in_progress" },
    });
    expect(own.status).toBe(200);
    const outOfScope = await call(w.ctx, w.teacher, "POST", "/progress-records", {
      body: { student_id: w.org.otherStudent.userId, teacher_id: w.org.teacher.userId, department_name: "営業部", due_date: "2026-10-29", content: "x", state: "in_progress" },
    });
    expect(outOfScope.status).toBe(403);
    const asSomeoneElse = await call(w.ctx, w.teacher, "POST", "/progress-records", {
      body: { student_id: w.org.student.userId, teacher_id: w.org.otherTeacher.userId, department_name: "開発部", due_date: "2026-10-29", content: "x", state: "in_progress" },
    });
    expect(asSomeoneElse.status).toBe(403);
    expect((await call(w.ctx, w.student, "POST", "/progress-records", { body: {} })).status).toBe(403);
  });
});

describe("PATCH and GET /progress-records/{id}", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    student_id: w.org.student.userId,
    teacher_id: w.org.teacher.userId,
    department_name: "開発部",
    due_date: "2026-10-01",
    content: "技術知識習得・プログラム言語習得",
    notes: "",
    state: "in_progress",
    ...over,
  });

  it("requires If-Match and a correction reason, and records before/after/reason/actor", async () => {
    expect((await call(w.ctx, w.admin, "PATCH", `/progress-records/${R.r1}`, { body: body() })).status).toBe(400);
    const stale = await call(w.ctx, w.admin, "PATCH", `/progress-records/${R.r1}`, { body: body({ due_date: "2026-10-05" }), ifMatch: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const same = await call(w.ctx, w.admin, "PATCH", `/progress-records/${R.r1}`, { body: body(), ifMatch: 1 });
    expect(same.status).toBe(200);
    expect(same.body.data.row_version).toBe(1);
    const noReason = await call(w.ctx, w.admin, "PATCH", `/progress-records/${R.r1}`, { body: body({ due_date: "2026-10-05" }), ifMatch: 1 });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe("REASON_REQUIRED");
    expect(noReason.body.field_errors.correction_reason).toBe("訂正理由を入力してください。");
    expectContract(noReason, "patch", "/progress-records/{id}");

    const ok = await call(w.ctx, w.teacher, "PATCH", `/progress-records/${R.r1}`, {
      body: body({ due_date: "2026-10-05", state: "review_pending", correction_reason: "研修日程の変更に伴う訂正" }),
      ifMatch: 1,
    });
    expect(ok.status).toBe(200);
    expectContract(ok, "patch", "/progress-records/{id}");
    expect(ok.body.data).toMatchObject({ due_date: "2026-10-05", state: "review_pending", row_version: 2 });

    const detail = await call(w.ctx, w.admin, "GET", `/progress-records/${R.r1}`);
    expect(detail.status).toBe(200);
    expectContract(detail, "get", "/progress-records/{id}");
    const entry = detail.body.data.history[0];
    expect(entry).toMatchObject({
      event_type: "progress_record.corrected",
      actor_id: w.org.teacher.userId,
      actor_name: "田中 祥司",
      reason: "研修日程の変更に伴う訂正",
      changes: { due_date: { before: "2026-10-01", after: "2026-10-05" }, state: { before: "in_progress", after: "review_pending" } },
    });
  });

  it("updates the 教育担当者 snapshot only when the teacher changes (admin) and enforces teacher scope", async () => {
    const changed = await call(w.ctx, w.admin, "PATCH", `/progress-records/${R.r4}`, {
      body: body({ student_id: w.org.otherStudent.userId, teacher_id: w.org.otherTeacher.userId, due_date: "2026-11-02", content: "サーバーの構築、製品動作試験", correction_reason: "担当者の訂正" }),
      ifMatch: 1,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.data.teacher_name).toBe("別府 悦子");
    const detail = await call(w.ctx, w.admin, "GET", `/progress-records/${R.r4}`);
    expect(detail.body.data.history[0].changes.teacher_name).toEqual({ before: "田中 祥司", after: "別府 悦子" });

    expect((await call(w.ctx, w.teacher, "GET", `/progress-records/${R.r3}`)).status).toBe(403);
    const forbidden = await call(w.ctx, w.teacher, "PATCH", `/progress-records/${R.r3}`, {
      body: body({ student_id: w.org.otherStudent.userId, teacher_id: w.org.otherTeacher.userId, correction_reason: "x" }),
      ifMatch: 1,
    });
    expect(forbidden.status).toBe(403);
    const reassign = await call(w.ctx, w.teacher, "PATCH", `/progress-records/${R.r5}`, {
      body: body({ due_date: "2019-08-31", content: "技術知識習得", state: "unverified", teacher_id: w.org.otherTeacher.userId, correction_reason: "x" }),
      ifMatch: 1,
    });
    expect(reassign.status).toBe(403);
    expect((await call(w.ctx, w.admin, "GET", `/progress-records/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call(w.ctx, w.student, "GET", `/progress-records/${R.r1}`)).status).toBe(403);
  });
});
