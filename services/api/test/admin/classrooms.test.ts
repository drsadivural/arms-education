import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { createClassroom, createStudent, createTeacher, seedOrg, type OrgScenario } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { completeUnit, createProgramVersion, createSlot, enroll, futureDate } from "../helpers/admin-fixtures";

let ctx: TestContext;
let org: OrgScenario;
let other: OrgScenario;
let admin: Caller;
let teacher: Caller;
let otherTeacher: Caller;
let student: Caller;

let seq = 0;
const classroomBody = (primary: string, extra: Record<string, unknown> = {}) => ({
  name: `2026年度 新入社員クラス${++seq}-${Date.now()}`,
  capacity: 30,
  starts_on: "2026-10-01",
  ends_on: "2026-12-31",
  primary_teacher_id: primary,
  ...extra,
});

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  other = await seedOrg(ctx.admin);
  admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
  teacher = await bearerCaller(org.teacher.userId, org.orgId);
  otherTeacher = await bearerCaller(org.otherTeacher.userId, org.orgId);
  student = await bearerCaller(org.student.userId, org.orgId);
});
afterAll(async () => ctx.close());

describe("GET /classrooms", () => {
  it("lists classrooms with SQL-computed student_count and progress", async () => {
    const p = await createProgramVersion(ctx.admin, org.orgId, { weights: [1, 3] });
    const e = await enroll(ctx.admin, org.orgId, org.student.userId, p.versionId);
    await completeUnit(ctx.admin, org.orgId, e, p.versionId, p.unitIds[1] as string);
    const res = await call(ctx, admin, "GET", "/classrooms");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/classrooms");
    const a = res.body.items.find((c: any) => c.id === org.classroomId);
    expect(a).toMatchObject({ student_count: 2, primary_teacher_id: org.teacher.userId, primary_teacher_name: "田中 祥司", archived: false });
    expect(a.average_progress_percent).toBe(75);
    expect(res.body.items.some((c: any) => c.id === other.classroomId)).toBe(false);
  });

  it("filters (q, status, teacher) and limits teachers to their classrooms", async () => {
    const mine = await call(ctx, teacher, "GET", "/classrooms");
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((c: any) => c.id)).toEqual([org.classroomId]);
    const byTeacher = await call(ctx, admin, "GET", `/classrooms?teacher_id=${org.otherTeacher.userId}`);
    expect(byTeacher.body.items.map((c: any) => c.id)).toEqual([org.otherClassroomId]);
    const archived = await call(ctx, admin, "GET", "/classrooms?status=archived");
    expect(archived.body.items).toEqual([]);
    const q = await call(ctx, admin, "GET", `/classrooms?q=${encodeURIComponent("Bクラス")}`);
    expect(q.body.items.map((c: any) => c.id)).toEqual([org.otherClassroomId]);
    const page1 = await call(ctx, admin, "GET", "/classrooms?limit=1");
    const page2 = await call(ctx, admin, "GET", `/classrooms?limit=1&cursor=${page1.body.next_cursor}`);
    expectContract(page2, "get", "/classrooms");
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    expect((await call(ctx, student, "GET", "/classrooms")).status).toBe(403);
    expect((await call(ctx, null, "GET", "/classrooms")).status).toBe(401);
  });
});

describe("GET /classrooms/{id} and sub-resources", () => {
  it("returns detail, students and selectable teachers within scope", async () => {
    const detail = await call(ctx, teacher, "GET", `/classrooms/${org.classroomId}`);
    expect(detail.status).toBe(200);
    expectContract(detail, "get", "/classrooms/{id}");
    const students = await call(ctx, teacher, "GET", `/classrooms/${org.classroomId}/students`);
    expect(students.status).toBe(200);
    expectContract(students, "get", "/classrooms/{id}/students");
    expect(students.body.items.map((s: any) => s.id).sort()).toEqual([org.student.userId, org.student2.userId].sort());
    const teachers = await call(ctx, admin, "GET", `/classrooms/${org.classroomId}/teachers`);
    expect(teachers.status).toBe(200);
    expectContract(teachers, "get", "/classrooms/{id}/teachers");
    expect(teachers.body.items.map((t: any) => t.id)).toEqual([org.teacher.userId]);
  });

  it("selectable teachers exclude inactive assistants and list the primary first", async () => {
    const assistant = await createTeacher(ctx.admin, org.orgId);
    const inactive = await createTeacher(ctx.admin, org.orgId, { active: false });
    const classroomId = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: org.otherTeacher.userId, assistantTeacherIds: [assistant.userId, inactive.userId] });
    const res = await call(ctx, admin, "GET", `/classrooms/${classroomId}/teachers`);
    expect(res.body.items.map((t: any) => t.id)).toEqual([org.otherTeacher.userId, assistant.userId]);
  });

  it("out-of-scope and foreign classrooms are 404", async () => {
    expect((await call(ctx, teacher, "GET", `/classrooms/${org.otherClassroomId}`)).status).toBe(404);
    expect((await call(ctx, teacher, "GET", `/classrooms/${org.otherClassroomId}/students`)).status).toBe(404);
    expect((await call(ctx, teacher, "GET", `/classrooms/${org.otherClassroomId}/teachers`)).status).toBe(404);
    const foreign = await call(ctx, admin, "GET", `/classrooms/${other.classroomId}/students`);
    expect(foreign.status).toBe(404);
    expectContract(foreign, "get", "/classrooms/{id}/students");
    expect((await call(ctx, otherTeacher, "GET", `/classrooms/${org.otherClassroomId}`)).status).toBe(200);
  });
});

describe("POST /classrooms", () => {
  it("creates the classroom with primary/assistant teachers and published programs", async () => {
    const assistant = await createTeacher(ctx.admin, org.orgId);
    const p = await createProgramVersion(ctx.admin, org.orgId);
    const body = classroomBody(org.teacher.userId, { assistant_teacher_ids: [assistant.userId], program_version_ids: [p.versionId] });
    const key = crypto.randomUUID();
    const res = await call(ctx, admin, "POST", "/classrooms", { body, idempotencyKey: key });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/classrooms");
    expect(res.body.data).toMatchObject({ name: body.name, capacity: 30, primary_teacher_id: org.teacher.userId, assistant_teacher_ids: [assistant.userId], program_version_ids: [p.versionId], student_count: 0 });
    expect(res.body.data.programs[0]).toMatchObject({ id: p.versionId, program_id: p.programId, version_number: 1 });
    const replay = await call(ctx, admin, "POST", "/classrooms", { body, idempotencyKey: key });
    expect(replay.body.data.id).toBe(res.body.data.id);
    const audit = await ctx.admin.query("SELECT count(*)::int AS n FROM app.audit_events WHERE entity_id = $1 AND event_type = 'classroom.created'", [res.body.data.id]);
    expect(audit.rows[0].n).toBe(1);
    const dup = await call(ctx, admin, "POST", "/classrooms", { body });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("CLASSROOM_NAME_TAKEN");
    expectContract(dup, "post", "/classrooms");
  });

  it("a teacher archived concurrently never ends up as primary teacher of an open classroom", async () => {
    for (let i = 0; i < 5; i++) {
      const t = await createTeacher(ctx.admin, org.orgId);
      const [archived, created] = await Promise.all([
        call(ctx, admin, "DELETE", `/teachers/${t.userId}`, { ifMatch: 1 }),
        call(ctx, admin, "POST", "/classrooms", { body: classroomBody(t.userId) }),
      ]);
      expect([archived.status, created.status]).not.toEqual([200, 200]);
      if (archived.status !== 200) expect(archived.body.code).toBe("TEACHER_IS_PRIMARY");
      if (created.status !== 200) expect(created.body.field_errors.primary_teacher_id).toBe("停止中の講師は選択できません。");
    }
  });

  it("refuses draft program versions, unknown/inactive teachers and invalid input", async () => {
    const draft = await createProgramVersion(ctx.admin, org.orgId, { state: "draft" });
    const res = await call(ctx, admin, "POST", "/classrooms", { body: classroomBody(org.teacher.userId, { program_version_ids: [draft.versionId] }) });
    expect(res.status).toBe(422);
    expect(res.body.field_errors.program_version_ids).toContain("公開済み");
    const inactive = await createTeacher(ctx.admin, org.orgId, { active: false });
    const t = await call(ctx, admin, "POST", "/classrooms", { body: classroomBody(inactive.userId) });
    expect(t.status).toBe(422);
    expect(t.body.field_errors.primary_teacher_id).toBe("停止中の講師は選択できません。");
    const foreign = await call(ctx, admin, "POST", "/classrooms", { body: classroomBody(other.teacher.userId) });
    expect(foreign.status).toBe(422);
    expect(foreign.body.field_errors.primary_teacher_id).toBe("選択した講師が見つかりません。");
    const invalid = await call(ctx, admin, "POST", "/classrooms", {
      body: classroomBody(org.teacher.userId, { capacity: 0, ends_on: "2026-09-01", assistant_teacher_ids: [org.teacher.userId] }),
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.field_errors.capacity).toBe("1以上の値を入力してください。");
    expect(invalid.body.field_errors.ends_on).toBe("終了日は開始日以降にしてください。");
    expect(invalid.body.field_errors.assistant_teacher_ids).toBe("主担当講師は補助講師に指定できません。");
    expect((await call(ctx, teacher, "POST", "/classrooms", { body: classroomBody(org.teacher.userId) })).status).toBe(403);
  });
});

describe("PATCH /classrooms/{id}", () => {
  async function fresh(primary: string, assistants: string[] = []) {
    const id = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: primary, assistantTeacherIds: assistants, capacity: 5 });
    const res = await call(ctx, admin, "GET", `/classrooms/${id}`);
    return res.body.data;
  }

  it("changes the primary teacher, assistants and programs", async () => {
    const t1 = await createTeacher(ctx.admin, org.orgId);
    const t2 = await createTeacher(ctx.admin, org.orgId);
    const p = await createProgramVersion(ctx.admin, org.orgId);
    const c = await fresh(t1.userId, [t2.userId]);
    const body = { name: c.name, capacity: 10, starts_on: c.starts_on, ends_on: c.ends_on, primary_teacher_id: t2.userId, assistant_teacher_ids: [t1.userId], program_version_ids: [p.versionId] };
    const res = await call(ctx, admin, "PATCH", `/classrooms/${c.id}`, { body, ifMatch: c.row_version });
    expect(res.status).toBe(200);
    expectContract(res, "patch", "/classrooms/{id}");
    expect(res.body.data).toMatchObject({ capacity: 10, primary_teacher_id: t2.userId, assistant_teacher_ids: [t1.userId], program_version_ids: [p.versionId], row_version: c.row_version + 1 });
    const stale = await call(ctx, admin, "PATCH", `/classrooms/${c.id}`, { body, ifMatch: c.row_version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const audit = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE entity_id = $1 AND event_type = 'classroom.updated'", [c.id]);
    expect(audit.rows[0].payload.changes.primary_teacher_id).toEqual({ before: t1.userId, after: t2.userId });
  });

  it("refuses removing a teacher who still has students or lesson slots in the classroom", async () => {
    const t1 = await createTeacher(ctx.admin, org.orgId);
    const t2 = await createTeacher(ctx.admin, org.orgId);
    const c = await fresh(t1.userId, [t2.userId]);
    await createStudent(ctx.admin, org.orgId, { classroomId: c.id, teacherId: t2.userId });
    const body = { name: c.name, capacity: c.capacity, starts_on: c.starts_on, ends_on: c.ends_on, primary_teacher_id: t1.userId, assistant_teacher_ids: [] };
    const res = await call(ctx, admin, "PATCH", `/classrooms/${c.id}`, { body, ifMatch: c.row_version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CLASSROOM_TEACHER_IN_USE");
    expect(res.body.details).toMatchObject({ teacher_id: t2.userId, student_count: 1 });
    expectContract(res, "patch", "/classrooms/{id}");

    const t3 = await createTeacher(ctx.admin, org.orgId);
    const c2 = await fresh(t1.userId, [t3.userId]);
    await createSlot(ctx.admin, org.orgId, { classroomId: c2.id, teacherId: t3.userId, startsAt: futureDate(40) });
    const res2 = await call(ctx, admin, "PATCH", `/classrooms/${c2.id}`, {
      body: { name: c2.name, capacity: c2.capacity, starts_on: c2.starts_on, ends_on: c2.ends_on, primary_teacher_id: t1.userId },
      ifMatch: c2.row_version,
    });
    expect(res2.status).toBe(409);
    expect(res2.body.details.slot_count).toBe(1);
  });

  it("refuses a capacity below the current enrolment (DB trigger)", async () => {
    const t1 = await createTeacher(ctx.admin, org.orgId);
    const c = await fresh(t1.userId);
    await createStudent(ctx.admin, org.orgId, { classroomId: c.id, teacherId: t1.userId });
    await createStudent(ctx.admin, org.orgId, { classroomId: c.id, teacherId: t1.userId });
    const res = await call(ctx, admin, "PATCH", `/classrooms/${c.id}`, {
      body: { name: c.name, capacity: 1, starts_on: c.starts_on, ends_on: c.ends_on, primary_teacher_id: t1.userId },
      ifMatch: c.row_version,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CAPACITY_BELOW_ENROLLMENT");
    expect(res.body.message_ja).toBe("在籍人数より少ない定員には変更できません。");
  });

  it("validates the body with Japanese field errors and refuses unknown/inactive new teachers", async () => {
    const c = await fresh(org.teacher.userId);
    const res = await call(ctx, admin, "PATCH", `/classrooms/${c.id}`, { body: { name: "", capacity: "多い", starts_on: "2026/10/01", ends_on: c.ends_on }, ifMatch: c.row_version });
    expect(res.status).toBe(422);
    expectContract(res, "patch", "/classrooms/{id}");
    expect(res.body.field_errors).toMatchObject({ name: "必須項目です。", capacity: "数値を入力してください。", primary_teacher_id: "必須項目です。" });
    expect(res.body.field_errors.starts_on).toContain("日付");
    const inactive = await createTeacher(ctx.admin, org.orgId, { active: false });
    const t = await call(ctx, admin, "PATCH", `/classrooms/${c.id}`, {
      body: { name: c.name, capacity: c.capacity, starts_on: c.starts_on, ends_on: c.ends_on, primary_teacher_id: org.teacher.userId, assistant_teacher_ids: [inactive.userId] },
      ifMatch: c.row_version,
    });
    expect(t.status).toBe(422);
    expect(t.body.field_errors.assistant_teacher_ids).toBe("停止中の講師は選択できません。");
  });

  it("teachers cannot edit; foreign classrooms are 404", async () => {
    const body = classroomBody(org.teacher.userId);
    expect((await call(ctx, teacher, "PATCH", `/classrooms/${org.classroomId}`, { body, ifMatch: 1 })).status).toBe(403);
    expect((await call(ctx, admin, "PATCH", `/classrooms/${other.classroomId}`, { body, ifMatch: 1 })).status).toBe(404);
  });
});

describe("DELETE /classrooms/{id} (archive)", () => {
  it("refuses while students are enrolled, archives an empty classroom", async () => {
    const v = (await call(ctx, admin, "GET", `/classrooms/${org.classroomId}`)).body.data.row_version;
    const blocked = await call(ctx, admin, "DELETE", `/classrooms/${org.classroomId}`, { ifMatch: v });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("CLASSROOM_HAS_STUDENTS");
    expectContract(blocked, "delete", "/classrooms/{id}");
    const t = await createTeacher(ctx.admin, org.orgId);
    const empty = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: t.userId });
    const res = await call(ctx, admin, "DELETE", `/classrooms/${empty}`, { ifMatch: 1 });
    expect(res.status).toBe(200);
    expectContract(res, "delete", "/classrooms/{id}");
    const read = await call(ctx, admin, "GET", `/classrooms/${empty}`);
    expect(read.body.data.archived).toBe(true);
    // The teacher is no longer primary of an open classroom → archiving the teacher becomes possible.
    const tv = (await call(ctx, admin, "GET", `/teachers/${t.userId}`)).body.data.row_version;
    expect((await call(ctx, admin, "DELETE", `/teachers/${t.userId}`, { ifMatch: tv })).status).toBe(200);
    // Archived classrooms cannot be selected for new students or edited.
    const edit = await call(ctx, admin, "PATCH", `/classrooms/${empty}`, { body: classroomBody(org.teacher.userId), ifMatch: read.body.data.row_version });
    expect(edit.status).toBe(409);
    expect((await call(ctx, teacher, "DELETE", `/classrooms/${empty}`, { ifMatch: 1 })).status).toBe(403);
  });
});
