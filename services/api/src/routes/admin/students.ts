/**
 * WEB-05/06 新入社員管理: list/read (admin; teacher limited to their scope), create (invitation saga),
 * edit, archive and transfer (admin). Capacity is guaranteed by the DB trigger (CLASSROOM_FULL).
 */
import { Hono } from "hono";
import { StudentInput, TransferInput, type StudentInputT } from "@arms/contracts";
import type { Actor, AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { pathId, readBody, readQuery, requireIfMatch } from "../../http/validation";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { action, ok, page } from "../../http/respond";
import { ListQuery, TextIdCursor, audit, diff, enqueue } from "../../domain/admin/common";
import { runInvitation } from "../../domain/admin/invitations";
import { lockMembership, setMembershipActive, syncProviderBan } from "../../domain/admin/accounts";
import { activeReservationCount, findStudent, listStudents } from "../../repositories/admin/students";

export const studentRoutes = new Hono<AppEnv>();

function normalize(input: StudentInputT) {
  return {
    employee_number: input.employee_number,
    display_name: input.display_name,
    kana: input.kana ?? "",
    email: input.email.trim(),
    company_name: input.company_name ?? "",
    department_name: input.department_name,
    joined_on: input.joined_on,
    classroom_id: input.classroom_id.toLowerCase(),
    teacher_id: input.teacher_id.toLowerCase(),
    training_starts_on: input.training_starts_on,
    training_due_on: input.training_due_on,
    active: input.active,
  };
}
type StudentPayload = ReturnType<typeof normalize>;

async function assertEmailFree(tx: Tx, email: string): Promise<void> {
  const taken = await tx.maybeOne(sql`SELECT 1 FROM app.users WHERE lower(email) = lower(${email})`);
  if (taken) fail("EMAIL_TAKEN", { field_errors: { email: "このメールアドレスは既に登録されています。" } });
}

async function assertEmployeeNumberFree(tx: Tx, orgId: string, employeeNumber: string, exceptId: string | null): Promise<void> {
  const taken = await tx.maybeOne(sql`
    SELECT 1 FROM app.student_profiles WHERE org_id = ${orgId} AND employee_number = ${employeeNumber} AND id IS DISTINCT FROM ${exceptId}::uuid`);
  if (taken) fail("EMPLOYEE_NUMBER_TAKEN", { field_errors: { employee_number: "この社員番号は既に登録されています。" } });
}

/** The selected classroom must be open and the teacher an active teacher assigned to it (WEB-06 講師候補連動). */
async function assertClassroomTeacher(tx: Tx, orgId: string, classroomId: string, teacherId: string): Promise<void> {
  const classroom = await tx.maybeOne<{ archived: boolean }>(sql`SELECT archived FROM app.classrooms WHERE org_id = ${orgId} AND id = ${classroomId}`);
  if (!classroom) fail("VALIDATION_FAILED", { field_errors: { classroom_id: "選択したクラスが見つかりません。" } });
  if (classroom.archived) fail("VALIDATION_FAILED", { field_errors: { classroom_id: "アーカイブ済みのクラスは選択できません。" } });
  const teacher = await tx.maybeOne<{ active: boolean }>(sql`
    SELECT m.active FROM app.classroom_teachers ct
    JOIN app.memberships m ON m.org_id = ct.org_id AND m.id = ct.teacher_id AND m.role = 'teacher'
    WHERE ct.org_id = ${orgId} AND ct.classroom_id = ${classroomId} AND ct.teacher_id = ${teacherId}`);
  if (!teacher) fail("TEACHER_CLASSROOM_MISMATCH", { field_errors: { teacher_id: "選択した講師はこのクラスの担当ではありません。" } });
  if (!teacher.active) fail("TEACHER_INACTIVE", { field_errors: { teacher_id: "停止中の講師は選択できません。" } });
}

/**
 * Early seat check before the Auth provider user is created: locks the classroom row (the same lock the capacity
 * trigger takes) and counts active students plus other in-flight student invitations for this classroom, so
 * concurrent requests for the last seat do not create provider accounts that can never get a profile.
 * The DB trigger remains the authoritative guarantee.
 */
async function assertSeatAvailable(tx: Tx, orgId: string, classroomId: string, exceptJobId: string | null): Promise<void> {
  const row = await tx.one<{ capacity: number; used: number; in_flight: number }>(sql`
    WITH c AS (SELECT capacity FROM app.classrooms WHERE org_id = ${orgId} AND id = ${classroomId} FOR UPDATE)
    SELECT c.capacity,
      (SELECT count(*)::int FROM app.student_profiles WHERE org_id = ${orgId} AND classroom_id = ${classroomId} AND active) AS used,
      (SELECT count(*)::int FROM app.invitation_jobs j
        WHERE j.org_id = ${orgId} AND j.role = 'student' AND j.state IN ('pending', 'auth_created')
          AND j.locked_until > now() AND j.profile_payload->>'classroom_id' = ${classroomId}
          AND (j.profile_payload->>'active')::boolean AND j.id IS DISTINCT FROM ${exceptJobId}::uuid) AS in_flight
    FROM c`);
  if (row.used + row.in_flight >= row.capacity) fail("CLASSROOM_FULL");
}

studentRoutes.get("/students", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const query = readQuery(c, ListQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, TextIdCursor);
  const rows = await actorTx(c, (tx) =>
    listStudents(tx, actor, {
      q: query.q,
      classroomId: query.classroom_id,
      teacherId: query.teacher_id,
      department: query.department,
      status: query.status,
      after: after ? { k: after.k, id: after.id } : null,
      limit,
    }),
  );
  const { items, nextCursor } = paginate(rows, limit, (s) => ({ k: s.employee_number, id: s.id }));
  return page(c, items, nextCursor);
});

studentRoutes.get("/students/:id", requireRole("admin", "teacher"), async (c) => {
  const id = pathId(c);
  const student = await actorTx(c, (tx) => findStudent(tx, c.get("actor"), id));
  if (!student) fail("NOT_FOUND");
  return ok(c, student, { version: student.row_version });
});

async function insertStudentProfile(tx: Tx, actor: Actor, p: StudentPayload, userId: string): Promise<void> {
  await tx.exec(sql`INSERT INTO app.users(id, display_name, email) VALUES (${userId}, ${p.display_name}, ${p.email})`);
  await tx.exec(sql`INSERT INTO app.memberships(org_id, id, role, active, disabled_at)
    VALUES (${actor.orgId}, ${userId}, 'student', ${p.active}, CASE WHEN ${p.active}::boolean THEN NULL ELSE now() END)`);
  await tx.exec(sql`
    INSERT INTO app.student_profiles(org_id, id, employee_number, kana, company_name, department_name, joined_on, classroom_id, teacher_id,
      training_starts_on, training_due_on, active)
    VALUES (${actor.orgId}, ${userId}, ${p.employee_number}, ${p.kana}, ${p.company_name}, ${p.department_name}, ${p.joined_on}::date,
      ${p.classroom_id}, ${p.teacher_id}, ${p.training_starts_on}::date, ${p.training_due_on}::date, ${p.active})`);
  await audit(tx, actor, "student.created", userId, {
    employee_number: p.employee_number,
    classroom_id: p.classroom_id,
    teacher_id: p.teacher_id,
    department_name: p.department_name,
    active: p.active,
  });
}

studentRoutes.post("/students", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const payload = normalize(await readBody(c, StudentInput));
  const outcome = await runInvitation(c, {
    email: payload.email,
    role: "student",
    displayName: payload.display_name,
    payload,
    async precheck(tx, jobId) {
      await assertEmailFree(tx, payload.email);
      await assertEmployeeNumberFree(tx, actor.orgId, payload.employee_number, null);
      await assertClassroomTeacher(tx, actor.orgId, payload.classroom_id, payload.teacher_id);
      if (payload.active) await assertSeatAvailable(tx, actor.orgId, payload.classroom_id, jobId);
    },
    async createProfile(tx, stored, userId) {
      await insertStudentProfile(tx, actor, stored as StudentPayload, userId);
    },
  });
  const student = await actorTx(c, (tx) => findStudent(tx, actor, outcome.userId));
  if (!student) fail("NOT_FOUND");
  c.header("ETag", `"${student.row_version}"`);
  return c.json({ data: student, invitation: outcome.result, checked_at: c.get("deps").now().toISOString() });
});

interface StudentState extends Omit<StudentPayload, "active"> {
  active: boolean;
  membership_active: boolean;
  row_version: number;
}

async function lockStudent(tx: Tx, orgId: string, id: string): Promise<StudentState> {
  const row = await tx.maybeOne<StudentState>(sql`
    SELECT sp.employee_number, u.display_name, sp.kana, u.email, sp.company_name, sp.department_name,
      to_char(sp.joined_on, 'YYYY-MM-DD') AS joined_on, sp.classroom_id, sp.teacher_id,
      to_char(sp.training_starts_on, 'YYYY-MM-DD') AS training_starts_on, to_char(sp.training_due_on, 'YYYY-MM-DD') AS training_due_on,
      sp.active, m.active AS membership_active, sp.row_version
    FROM app.student_profiles sp
    JOIN app.memberships m ON m.org_id = sp.org_id AND m.id = sp.id
    JOIN app.users u ON u.id = sp.id
    WHERE sp.org_id = ${orgId} AND sp.id = ${id}
    FOR UPDATE OF sp`);
  if (!row) fail("NOT_FOUND");
  return row;
}

/** Edit: classroom/teacher changes go through POST /students/{id}/transfer (reason + audit). */
studentRoutes.patch("/students/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = normalize(await readBody(c, StudentInput));
  const result = await actorTx(c, async (tx) => {
    const before = await lockStudent(tx, actor.orgId, id);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    if (before.classroom_id !== input.classroom_id || before.teacher_id !== input.teacher_id) fail("CLASSROOM_TRANSFER_REQUIRES_SERVICE");
    if (before.email.toLowerCase() !== input.email.toLowerCase()) {
      fail("VALIDATION_FAILED", { field_errors: { email: "メールアドレスはログインIDのため変更できません。別のアカウントとして招待してください。" } });
    }
    await assertEmployeeNumberFree(tx, actor.orgId, input.employee_number, id);
    const activeChanged = before.active !== input.active;
    if (activeChanged && !input.active && (await activeReservationCount(tx, actor.orgId, id)) > 0) fail("ACTIVE_RESERVATIONS");
    await tx.exec(sql`UPDATE app.users SET display_name = ${input.display_name} WHERE id = ${id}`);
    // The capacity trigger re-checks the classroom when the student becomes active again (CLASSROOM_FULL).
    const updated = await tx.maybeOne<{ row_version: number }>(sql`
      UPDATE app.student_profiles SET employee_number = ${input.employee_number}, kana = ${input.kana}, company_name = ${input.company_name},
        department_name = ${input.department_name}, joined_on = ${input.joined_on}::date, training_starts_on = ${input.training_starts_on}::date,
        training_due_on = ${input.training_due_on}::date, active = ${input.active}, row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${id} AND row_version = ${expected} RETURNING row_version`);
    if (!updated) fail("VERSION_CONFLICT");
    let membershipChanged = false;
    if (activeChanged && before.membership_active !== input.active) {
      await lockMembership(tx, actor.orgId, id);
      await setMembershipActive(tx, actor.orgId, id, input.active);
      membershipChanged = true;
    }
    const changes = diff(before as unknown as Record<string, unknown>, { ...input } as Record<string, unknown>);
    await audit(tx, actor, activeChanged && !input.active ? "student.archived" : "student.updated", id, { changes });
    return { membershipChanged, student: await findStudent(tx, actor, id) };
  });
  if (result.membershipChanged) await syncProviderBan(c, id, !input.active);
  if (!result.student) fail("NOT_FOUND");
  return ok(c, result.student, { version: result.student.row_version });
});

/** Archive (在籍終了): profile + membership inactive, sessions revoked; refused with seat-holding reservations. */
studentRoutes.delete("/students/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const result = await actorTx(c, async (tx) => {
    const before = await lockStudent(tx, actor.orgId, id);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    if (!before.active && !before.membership_active) return { changed: false, row_version: before.row_version };
    if ((await activeReservationCount(tx, actor.orgId, id)) > 0) fail("ACTIVE_RESERVATIONS");
    const updated = await tx.one<{ row_version: number }>(sql`
      UPDATE app.student_profiles SET active = false, row_version = row_version + 1 WHERE org_id = ${actor.orgId} AND id = ${id} RETURNING row_version`);
    if (before.membership_active) {
      await lockMembership(tx, actor.orgId, id);
      await setMembershipActive(tx, actor.orgId, id, false);
    }
    await audit(tx, actor, "student.archived", id, { employee_number: before.employee_number, classroom_id: before.classroom_id });
    return { changed: before.membership_active, row_version: updated.row_version };
  });
  const sync = result.changed ? await syncProviderBan(c, id, true) : { provider_synced: true };
  c.header("ETag", `"${result.row_version}"`);
  return action(c, { id, active: false, row_version: result.row_version, ...sync });
});

/** Classroom/teacher change through app.transfer_student (admin only, locks both classrooms in UUID order). */
studentRoutes.post("/students/:id/transfer", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const input = await readBody(c, TransferInput);
  const classroomId = input.classroom_id.toLowerCase();
  const teacherId = input.teacher_id.toLowerCase();
  const stored = await actorTx(c, (tx) =>
    idempotent(c, tx, { id, ...input }, async () => {
      const before = await tx.maybeOne<{ classroom_id: string; teacher_id: string }>(sql`
        SELECT classroom_id, teacher_id FROM app.student_profiles WHERE org_id = ${actor.orgId} AND id = ${id}`);
      if (!before) fail("NOT_FOUND");
      const target = await tx.maybeOne<{ archived: boolean }>(sql`SELECT archived FROM app.classrooms WHERE org_id = ${actor.orgId} AND id = ${classroomId}`);
      if (!target) fail("VALIDATION_FAILED", { field_errors: { classroom_id: "選択したクラスが見つかりません。" } });
      if (target.archived) fail("VALIDATION_FAILED", { field_errors: { classroom_id: "アーカイブ済みのクラスは選択できません。" } });
      await tx.query(sql`SELECT app.transfer_student(${id}, ${classroomId}, ${teacherId}, ${input.expected_version}, ${input.reason})`);
      await enqueue(tx, actor.orgId, "student.transferred", id, {
        student_id: id,
        from_classroom_id: before.classroom_id,
        from_teacher_id: before.teacher_id,
        classroom_id: classroomId,
        teacher_id: teacherId,
      });
      const student = await findStudent(tx, actor, id);
      return { status: 200, body: { data: student, checked_at: c.get("deps").now().toISOString() } };
    }),
  );
  const data = stored.body.data;
  if (data) c.header("ETag", `"${data.row_version}"`);
  return c.json(stored.body);
});
