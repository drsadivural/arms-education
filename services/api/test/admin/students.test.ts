import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { createClassroom, createStudent, createTeacher, seedOrg, type OrgScenario } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { completeUnit, createProgramVersion, createReservation, createSlot, enroll, futureDate } from "../helpers/admin-fixtures";

let ctx: TestContext;
let org: OrgScenario;
let other: OrgScenario;
let admin: Caller;
let teacher: Caller;
let otherTeacher: Caller;
let student: Caller;

let n = 0;
const studentBody = (classroomId: string, teacherId: string, extra: Record<string, unknown> = {}) => {
  n++;
  return {
    employee_number: `E-${Date.now()}-${n}`,
    display_name: `新人 太郎${n}`,
    kana: "しんじん たろう",
    email: `new-student-${Date.now()}-${n}@example.invalid`,
    company_name: "H&A",
    department_name: "開発部",
    joined_on: "2026-10-01",
    classroom_id: classroomId,
    teacher_id: teacherId,
    training_starts_on: "2026-10-01",
    training_due_on: "2026-12-31",
    active: true,
    ...extra,
  };
};

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

describe("GET /students", () => {
  it("returns students with progress from enrollment_progress (average over enrollments, rounded)", async () => {
    const p1 = await createProgramVersion(ctx.admin, org.orgId, { weights: [1, 1, 1] });
    const p2 = await createProgramVersion(ctx.admin, org.orgId, { weights: [1] });
    const e1 = await enroll(ctx.admin, org.orgId, org.student.userId, p1.versionId);
    await enroll(ctx.admin, org.orgId, org.student.userId, p2.versionId);
    await completeUnit(ctx.admin, org.orgId, e1, p1.versionId, p1.unitIds[0] as string);
    const res = await call(ctx, admin, "GET", "/students");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/students");
    const wada = res.body.items.find((s: any) => s.id === org.student.userId);
    // enrollment 1: 33%, enrollment 2: 0% → round(16.5) = 17
    expect(wada.progress_percent).toBe(17);
    expect(wada.classroom_id).toBe(org.classroomId);
    expect(wada.teacher_name).toBe("田中 祥司");
    const takahashi = res.body.items.find((s: any) => s.id === org.student2.userId);
    expect(takahashi.progress_percent).toBeNull();
    expect(res.body.items.some((s: any) => s.id === other.student.userId)).toBe(false);
  });

  it("filters by q (name/kana/number/email), classroom, teacher, department, status", async () => {
    const byName = await call(ctx, admin, "GET", `/students?q=${encodeURIComponent("和田")}`);
    expect(byName.body.items.map((s: any) => s.id)).toEqual([org.student.userId]);
    const byEmail = await call(ctx, admin, "GET", `/students?q=${encodeURIComponent(org.otherStudent.email)}`);
    expect(byEmail.body.items.map((s: any) => s.id)).toEqual([org.otherStudent.userId]);
    const byClass = await call(ctx, admin, "GET", `/students?classroom_id=${org.otherClassroomId}`);
    expect(byClass.body.items.map((s: any) => s.id)).toEqual([org.otherStudent.userId]);
    const byTeacher = await call(ctx, admin, "GET", `/students?teacher_id=${org.teacher.userId}&department=${encodeURIComponent("開発部")}`);
    expect(byTeacher.body.items.length).toBeGreaterThanOrEqual(2);
    expect(byTeacher.body.items.every((s: any) => s.teacher_id === org.teacher.userId)).toBe(true);
    const inactive = await call(ctx, admin, "GET", "/students?status=inactive");
    expect(inactive.status).toBe(200);
    expect(inactive.body.items.every((s: any) => s.active === false)).toBe(true);
    const page1 = await call(ctx, admin, "GET", "/students?limit=1");
    const page2 = await call(ctx, admin, "GET", `/students?limit=1&cursor=${page1.body.next_cursor}`);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    const badCursor = await call(ctx, admin, "GET", "/students?cursor=zzz");
    expect(badCursor.status).toBe(400);
  });

  it("limits teachers to their scope", async () => {
    const res = await call(ctx, teacher, "GET", "/students");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/students");
    const ids = res.body.items.map((s: any) => s.id).sort();
    expect(ids).toEqual([org.student.userId, org.student2.userId].sort());
    const others = await call(ctx, otherTeacher, "GET", "/students");
    expect(others.body.items.map((s: any) => s.id)).toEqual([org.otherStudent.userId]);
  });

  it("an assistant teacher of the classroom sees its students", async () => {
    const assistant = await createTeacher(ctx.admin, org.orgId);
    await ctx.admin.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id) VALUES ($1, $2, $3)", [org.orgId, org.otherClassroomId, assistant.userId]);
    const res = await call(ctx, await bearerCaller(assistant.userId, org.orgId), "GET", "/students");
    expect(res.body.items.map((s: any) => s.id)).toEqual([org.otherStudent.userId]);
  });

  it("rejects students and anonymous callers", async () => {
    expect((await call(ctx, student, "GET", "/students")).status).toBe(403);
    expect((await call(ctx, null, "GET", "/students")).status).toBe(401);
  });
});

describe("GET /students/{id}", () => {
  it("allows in-scope reads and hides out-of-scope students (404)", async () => {
    const ok = await call(ctx, teacher, "GET", `/students/${org.student.userId}`);
    expect(ok.status).toBe(200);
    expectContract(ok, "get", "/students/{id}");
    const outOfScope = await call(ctx, teacher, "GET", `/students/${org.otherStudent.userId}`);
    expect(outOfScope.status).toBe(404);
    expectContract(outOfScope, "get", "/students/{id}");
    expect((await call(ctx, admin, "GET", `/students/${other.student.userId}`)).status).toBe(404);
    expect((await call(ctx, student, "GET", `/students/${org.student.userId}`)).status).toBe(403);
  });
});

describe("POST /students", () => {
  it("creates the student through the invitation saga", async () => {
    const body = studentBody(org.classroomId, org.teacher.userId);
    const res = await call(ctx, admin, "POST", "/students", { body });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/students");
    expect(res.body.data).toMatchObject({ employee_number: body.employee_number, classroom_id: org.classroomId, teacher_id: org.teacher.userId, active: true, progress_percent: null });
    expect(res.body.invitation.state).toBe("sent");
    const classroom = await call(ctx, admin, "GET", `/classrooms/${org.classroomId}`);
    expect(classroom.body.data.student_count).toBe(3);
  });

  it("refuses a teacher not assigned to the classroom (422) and an inactive assigned teacher", async () => {
    const mismatch = await call(ctx, admin, "POST", "/students", { body: studentBody(org.classroomId, org.otherTeacher.userId) });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe("TEACHER_CLASSROOM_MISMATCH");
    expect(mismatch.body.field_errors.teacher_id).toBeTruthy();
    expectContract(mismatch, "post", "/students");
    const inactive = await createTeacher(ctx.admin, org.orgId, { active: false });
    await ctx.admin.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id) VALUES ($1, $2, $3)", [org.orgId, org.classroomId, inactive.userId]);
    const res = await call(ctx, admin, "POST", "/students", { body: studentBody(org.classroomId, inactive.userId) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("TEACHER_INACTIVE");
    const foreignClass = await call(ctx, admin, "POST", "/students", { body: studentBody(other.classroomId, other.teacher.userId) });
    expect(foreignClass.status).toBe(422);
    expect(foreignClass.body.field_errors.classroom_id).toBeTruthy();
  });

  it("rejects duplicate employee numbers and e-mails, and validates dates", async () => {
    const existing = await ctx.admin.query("SELECT employee_number FROM app.student_profiles WHERE id = $1", [org.student.userId]);
    const dupNumber = await call(ctx, admin, "POST", "/students", { body: studentBody(org.classroomId, org.teacher.userId, { employee_number: existing.rows[0].employee_number }) });
    expect(dupNumber.status).toBe(409);
    expect(dupNumber.body.code).toBe("EMPLOYEE_NUMBER_TAKEN");
    const dupEmail = await call(ctx, admin, "POST", "/students", { body: studentBody(org.classroomId, org.teacher.userId, { email: org.student.email.toUpperCase() }) });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.code).toBe("EMAIL_TAKEN");
    const dates = await call(ctx, admin, "POST", "/students", { body: studentBody(org.classroomId, org.teacher.userId, { training_due_on: "2026-09-01", joined_on: "2026-02-30" }) });
    expect(dates.status).toBe(422);
    expect(dates.body.field_errors.joined_on).toContain("日付");
    const order = await call(ctx, admin, "POST", "/students", { body: studentBody(org.classroomId, org.teacher.userId, { training_due_on: "2026-09-01" }) });
    expect(order.status).toBe(422);
    expect(order.body.field_errors.training_due_on).toBe("研修終了予定日は開始日以降にしてください。");
    expectContract(dates, "post", "/students");
  });

  it("enforces classroom capacity and never exceeds it under 10 concurrent creations", async () => {
    const t = await createTeacher(ctx.admin, org.orgId);
    const classroomId = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: t.userId, capacity: 1 });
    const usersBefore = ctx.auth.users.size;
    const results = await Promise.all(Array.from({ length: 10 }, () => call(ctx, admin, "POST", "/students", { body: studentBody(classroomId, t.userId) })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "CLASSROOM_FULL")).toBe(true);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    for (const r of results) expectContract(r, "post", "/students");
    const { rows } = await ctx.admin.query("SELECT count(*)::int AS n FROM app.student_profiles WHERE classroom_id = $1 AND active", [classroomId]);
    expect(rows[0].n).toBe(1);
    // The early seat check keeps the losers from creating provider accounts.
    expect(ctx.auth.users.size - usersBefore).toBe(1);
    const full = await call(ctx, admin, "POST", "/students", { body: studentBody(classroomId, t.userId) });
    expect(full.status).toBe(409);
    expect(full.body.message_ja).toBe("クラスの定員に達しています。");
    // Inactive registrations do not take a seat.
    const inactive = await call(ctx, admin, "POST", "/students", { body: studentBody(classroomId, t.userId, { active: false }) });
    expect(inactive.status).toBe(200);
    expect(inactive.body.invitation.state).toBe("pending");
  });

  it("the DB trigger is the final capacity guarantee; the saga resumes at the profile step with the same key", async () => {
    const t = await createTeacher(ctx.admin, org.orgId);
    const classroomId = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: t.userId, capacity: 1 });
    const body = studentBody(classroomId, t.userId);
    const key = crypto.randomUUID();
    const original = ctx.auth.adminCreateUser.bind(ctx.auth);
    let filler: string | null = null;
    // The last seat is taken by someone else between the early seat check and the profile insert.
    ctx.auth.adminCreateUser = async (email: string) => {
      filler = (await createStudent(ctx.admin, org.orgId, { classroomId, teacherId: t.userId })).userId;
      return original(email);
    };
    const full = await call(ctx, admin, "POST", "/students", { body, idempotencyKey: key });
    ctx.auth.adminCreateUser = original;
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("CLASSROOM_FULL");
    const job = await ctx.admin.query("SELECT state, error_code, auth_user_id FROM app.invitation_jobs WHERE org_id = $1 AND lower(email) = lower($2)", [org.orgId, body.email]);
    expect(job.rows[0]).toMatchObject({ state: "auth_created", error_code: "CLASSROOM_FULL" });
    await ctx.admin.query("UPDATE app.student_profiles SET active = false WHERE id = $1", [filler]);
    const usersBefore = ctx.auth.users.size;
    const retry = await call(ctx, admin, "POST", "/students", { body, idempotencyKey: key });
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(job.rows[0].auth_user_id);
    expect(ctx.auth.users.size).toBe(usersBefore);
  });

  it("requires admin", async () => {
    expect((await call(ctx, teacher, "POST", "/students", { body: studentBody(org.classroomId, org.teacher.userId) })).status).toBe(403);
    expect((await call(ctx, null, "POST", "/students", { body: studentBody(org.classroomId, org.teacher.userId) })).status).toBe(401);
  });
});

describe("PATCH /students/{id}", () => {
  async function current(id: string) {
    const res = await call(ctx, admin, "GET", `/students/${id}`);
    return res.body.data;
  }

  it("updates profile fields with If-Match", async () => {
    const s = await createStudent(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId });
    const cur = await current(s.userId);
    const body = { ...studentBody(org.classroomId, org.teacher.userId), employee_number: cur.employee_number, email: s.email, department_name: "営業部", display_name: "変更 後" };
    const res = await call(ctx, admin, "PATCH", `/students/${s.userId}`, { body, ifMatch: cur.row_version });
    expect(res.status).toBe(200);
    expectContract(res, "patch", "/students/{id}");
    expect(res.body.data).toMatchObject({ department_name: "営業部", display_name: "変更 後", row_version: cur.row_version + 1 });
    const stale = await call(ctx, admin, "PATCH", `/students/${s.userId}`, { body, ifMatch: cur.row_version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
  });

  it("refuses classroom/teacher changes (transfer service required) and e-mail changes", async () => {
    const s = await createStudent(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId });
    const cur = await current(s.userId);
    const moved = await call(ctx, admin, "PATCH", `/students/${s.userId}`, {
      body: { ...studentBody(org.otherClassroomId, org.otherTeacher.userId), employee_number: cur.employee_number, email: s.email },
      ifMatch: cur.row_version,
    });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe("CLASSROOM_TRANSFER_REQUIRES_SERVICE");
    expectContract(moved, "patch", "/students/{id}");
    const email = await call(ctx, admin, "PATCH", `/students/${s.userId}`, { body: { ...studentBody(org.classroomId, org.teacher.userId), employee_number: cur.employee_number }, ifMatch: cur.row_version });
    expect(email.status).toBe(422);
    expect(email.body.field_errors.email).toBeTruthy();
  });

  it("re-activation is capacity checked by the DB (CLASSROOM_FULL)", async () => {
    const t = await createTeacher(ctx.admin, org.orgId);
    const classroomId = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: t.userId, capacity: 1 });
    await createStudent(ctx.admin, org.orgId, { classroomId, teacherId: t.userId });
    const left = await createStudent(ctx.admin, org.orgId, { classroomId, teacherId: t.userId, active: false });
    const cur = await current(left.userId);
    const res = await call(ctx, admin, "PATCH", `/students/${left.userId}`, {
      body: { ...studentBody(classroomId, t.userId), employee_number: cur.employee_number, email: left.email, active: true },
      ifMatch: cur.row_version,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CLASSROOM_FULL");
  });

  it("teachers cannot edit; other organisations are 404", async () => {
    expect((await call(ctx, teacher, "PATCH", `/students/${org.student.userId}`, { body: studentBody(org.classroomId, org.teacher.userId), ifMatch: 1 })).status).toBe(403);
    const foreign = await call(ctx, admin, "PATCH", `/students/${other.student.userId}`, { body: studentBody(other.classroomId, other.teacher.userId), ifMatch: 1 });
    expect(foreign.status).toBe(404);
  });
});

describe("DELETE /students/{id} (archive)", () => {
  it("refuses while the student holds a reservation, then archives and frees the seat", async () => {
    const s = await createStudent(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId });
    ctx.auth.register(s.email, "pw", s.userId);
    const slot = await createSlot(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId, startsAt: futureDate(10) });
    const reservation = await createReservation(ctx.admin, org.orgId, { slotId: slot, studentId: s.userId, status: "approved" });
    const before = (await call(ctx, admin, "GET", `/classrooms/${org.classroomId}`)).body.data.student_count;
    const cur = (await call(ctx, admin, "GET", `/students/${s.userId}`)).body.data;
    const blocked = await call(ctx, admin, "DELETE", `/students/${s.userId}`, { ifMatch: cur.row_version });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("ACTIVE_RESERVATIONS");
    expectContract(blocked, "delete", "/students/{id}");
    await ctx.admin.query("UPDATE app.reservations SET status = 'cancelled' WHERE id = $1", [reservation]);
    const res = await call(ctx, admin, "DELETE", `/students/${s.userId}`, { ifMatch: cur.row_version });
    expect(res.status).toBe(200);
    expectContract(res, "delete", "/students/{id}");
    const after = (await call(ctx, admin, "GET", `/classrooms/${org.classroomId}`)).body.data.student_count;
    expect(after).toBe(before - 1);
    const member = await ctx.admin.query("SELECT active FROM app.memberships WHERE id = $1", [s.userId]);
    expect(member.rows[0].active).toBe(false);
    expect(ctx.auth.users.get(s.email.toLowerCase())?.banned).toBe(true);
    const bearer = await bearerCaller(s.userId, org.orgId);
    expect((await call(ctx, bearer, "GET", "/me")).status).toBe(403);
    expect((await call(ctx, teacher, "DELETE", `/students/${s.userId}`, { ifMatch: 1 })).status).toBe(403);
  });
});

describe("POST /students/{id}/transfer", () => {
  it("moves the student with app.transfer_student, audits and notifies, idempotently", async () => {
    const s = await createStudent(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId });
    const cur = (await call(ctx, admin, "GET", `/students/${s.userId}`)).body.data;
    const body = { classroom_id: org.otherClassroomId, teacher_id: org.otherTeacher.userId, reason: "配属変更のため", expected_version: cur.row_version };
    const key = crypto.randomUUID();
    const res = await call(ctx, admin, "POST", `/students/${s.userId}/transfer`, { body, idempotencyKey: key });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/students/{id}/transfer");
    expect(res.body.data).toMatchObject({ classroom_id: org.otherClassroomId, teacher_id: org.otherTeacher.userId, row_version: cur.row_version + 1 });
    const replay = await call(ctx, admin, "POST", `/students/${s.userId}/transfer`, { body, idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.body.data.row_version).toBe(cur.row_version + 1);
    const audit = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE entity_id = $1 AND event_type = 'student.transferred'", [s.userId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.reason).toBe("配属変更のため");
    const outbox = await ctx.admin.query("SELECT count(*)::int AS n FROM app.outbox WHERE entity_id = $1 AND event_type = 'student.transferred'", [s.userId]);
    expect(outbox.rows[0].n).toBe(1);
    // The old teacher no longer sees the student; the new one does.
    expect((await call(ctx, teacher, "GET", `/students/${s.userId}`)).status).toBe(404);
    expect((await call(ctx, otherTeacher, "GET", `/students/${s.userId}`)).status).toBe(200);
  });

  it("maps DB rule violations to Japanese errors", async () => {
    const s = await createStudent(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId });
    const cur = (await call(ctx, admin, "GET", `/students/${s.userId}`)).body.data;
    const mismatch = await call(ctx, admin, "POST", `/students/${s.userId}/transfer`, {
      body: { classroom_id: org.otherClassroomId, teacher_id: org.teacher.userId, reason: "移動", expected_version: cur.row_version },
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe("TEACHER_CLASSROOM_MISMATCH");
    expectContract(mismatch, "post", "/students/{id}/transfer");
    const stale = await call(ctx, admin, "POST", `/students/${s.userId}/transfer`, {
      body: { classroom_id: org.otherClassroomId, teacher_id: org.otherTeacher.userId, reason: "移動", expected_version: cur.row_version + 3 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const noReason = await call(ctx, admin, "POST", `/students/${s.userId}/transfer`, {
      body: { classroom_id: org.otherClassroomId, teacher_id: org.otherTeacher.userId, reason: " ", expected_version: cur.row_version },
    });
    expect(noReason.status).toBe(422);
    expect(noReason.body.field_errors.reason).toBe("理由を入力してください。");
    const t = await createTeacher(ctx.admin, org.orgId);
    const tiny = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: t.userId, capacity: 1 });
    await createStudent(ctx.admin, org.orgId, { classroomId: tiny, teacherId: t.userId });
    const full = await call(ctx, admin, "POST", `/students/${s.userId}/transfer`, {
      body: { classroom_id: tiny, teacher_id: t.userId, reason: "移動", expected_version: cur.row_version },
    });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("CLASSROOM_FULL");
    expect((await call(ctx, teacher, "POST", `/students/${s.userId}/transfer`, { body: { classroom_id: tiny, teacher_id: t.userId, reason: "x", expected_version: 1 } })).status).toBe(403);
    const foreign = await call(ctx, admin, "POST", `/students/${other.student.userId}/transfer`, {
      body: { classroom_id: org.otherClassroomId, teacher_id: org.otherTeacher.userId, reason: "x", expected_version: 1 },
    });
    expect(foreign.status).toBe(404);
  });
});
