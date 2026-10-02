/**
 * WEB-07/08 クラスルーム管理. Create/edit maintain classroom_teachers (exactly one primary + assistants) and
 * classroom_programs (published program versions). student_count is computed in SQL on every read.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ClassroomInput, zId, type ClassroomInputT } from "@arms/contracts";
import type { Actor, AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { ApiError, fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { pathId, readBody, readQuery, requireIfMatch } from "../../http/validation";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { action, ok, page } from "../../http/respond";
import { ListQuery, audit, diff, optionalQuery, zQueryText } from "../../domain/admin/common";
import { classroomTeacherUsage, findClassroom, listClassrooms } from "../../repositories/admin/classrooms";
import { listStudents } from "../../repositories/admin/students";
import { listTeachers } from "../../repositories/admin/teachers";

export const classroomRoutes = new Hono<AppEnv>();

const ClassroomListQuery = z.object({
  cursor: optionalQuery(z.string().max(1000)),
  limit: optionalQuery(z.string()),
  q: optionalQuery(zQueryText),
  teacher_id: optionalQuery(zId),
  status: optionalQuery(z.enum(["active", "archived"])),
});
const ClassroomCursor = z.object({ d: z.iso.date(), name: z.string(), id: zId });

interface Normalized {
  name: string;
  capacity: number;
  starts_on: string;
  ends_on: string;
  primary_teacher_id: string;
  assistant_teacher_ids: string[];
  program_version_ids: string[];
}

function normalize(input: ClassroomInputT): Normalized {
  const primary = input.primary_teacher_id.toLowerCase();
  return {
    name: input.name,
    capacity: input.capacity,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
    primary_teacher_id: primary,
    assistant_teacher_ids: [...new Set((input.assistant_teacher_ids ?? []).map((t) => t.toLowerCase()))].sort(),
    program_version_ids: [...new Set((input.program_version_ids ?? []).map((v) => v.toLowerCase()))].sort(),
  };
}

/** Newly assigned teachers must be active teachers of the organisation (already assigned ones may stay). */
async function assertTeachersSelectable(tx: Tx, orgId: string, input: Normalized, alreadyAssigned: Set<string>): Promise<void> {
  const wanted = [input.primary_teacher_id, ...input.assistant_teacher_ids].filter((t) => !alreadyAssigned.has(t));
  if (wanted.length === 0) return;
  const rows = await tx.query<{ id: string; active: boolean }>(sql`
    SELECT tp.id, m.active FROM app.teacher_profiles tp JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id
    WHERE tp.org_id = ${orgId} AND tp.id = ANY(${wanted}::uuid[])`);
  const found = new Map(rows.map((r) => [r.id, r.active]));
  const field_errors: Record<string, string> = {};
  for (const t of wanted) {
    const field = t === input.primary_teacher_id ? "primary_teacher_id" : "assistant_teacher_ids";
    if (!found.has(t)) field_errors[field] ??= "選択した講師が見つかりません。";
    else if (!found.get(t)) field_errors[field] ??= "停止中の講師は選択できません。";
  }
  if (Object.keys(field_errors).length) fail("VALIDATION_FAILED", { field_errors });
}

/** Newly linked program versions must be published. */
async function assertVersionsPublished(tx: Tx, orgId: string, versionIds: string[]): Promise<void> {
  if (versionIds.length === 0) return;
  const rows = await tx.query<{ id: string; state: string }>(sql`
    SELECT id, state FROM app.program_versions WHERE org_id = ${orgId} AND id = ANY(${versionIds}::uuid[])`);
  const published = new Set(rows.filter((r) => r.state === "published").map((r) => r.id));
  if (versionIds.some((v) => !published.has(v))) {
    fail("VALIDATION_FAILED", { field_errors: { program_version_ids: "公開済みの教育プログラム（バージョン）のみ選択できます。" } });
  }
}

async function assertNameFree(tx: Tx, orgId: string, name: string, startsOn: string, exceptId: string | null): Promise<void> {
  const taken = await tx.maybeOne(sql`
    SELECT 1 FROM app.classrooms WHERE org_id = ${orgId} AND name = ${name} AND starts_on = ${startsOn}::date AND id IS DISTINCT FROM ${exceptId}::uuid`);
  if (taken) fail("CLASSROOM_NAME_TAKEN", { field_errors: { name: "同じ名称・開始日のクラスが既に登録されています。" } });
}

function isPgError(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === code;
}

classroomRoutes.get("/classrooms", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const query = readQuery(c, ClassroomListQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, ClassroomCursor);
  const rows = await actorTx(c, (tx) =>
    listClassrooms(tx, actor, { q: query.q, status: query.status, teacherId: query.teacher_id, after: after ? { d: after.d, name: after.name, id: after.id } : null, limit }),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ d: r.starts_on, name: r.name, id: r.id }));
  return page(c, items, nextCursor);
});

classroomRoutes.get("/classrooms/:id", requireRole("admin", "teacher"), async (c) => {
  const id = pathId(c);
  const classroom = await actorTx(c, (tx) => findClassroom(tx, c.get("actor"), id));
  if (!classroom) fail("NOT_FOUND");
  return ok(c, classroom, { version: classroom.row_version });
});

classroomRoutes.get("/classrooms/:id/students", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const query = readQuery(c, ListQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, z.object({ k: z.string(), id: zId }));
  const rows = await actorTx(c, async (tx) => {
    if (!(await findClassroom(tx, actor, id))) fail("NOT_FOUND");
    return listStudents(tx, actor, {
      q: query.q,
      classroomId: id,
      teacherId: query.teacher_id,
      department: query.department,
      status: query.status,
      after: after ? { k: after.k, id: after.id } : null,
      limit,
    });
  });
  const { items, nextCursor } = paginate(rows, limit, (s) => ({ k: s.employee_number, id: s.id }));
  return page(c, items, nextCursor);
});

/** Selectable teachers for the student form: active teachers assigned to the classroom (≤ 51 per classroom). */
classroomRoutes.get("/classrooms/:id/teachers", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const rows = await actorTx(c, async (tx) => {
    if (!(await findClassroom(tx, actor, id))) fail("NOT_FOUND");
    return listTeachers(tx, actor.orgId, { selectableInClassroom: id, limit: 100 });
  });
  const primaryFirst = [...rows].sort((a, b) => {
    const pa = a.classrooms.some((x) => x.id === id && x.is_primary) ? 0 : 1;
    const pb = b.classrooms.some((x) => x.id === id && x.is_primary) ? 0 : 1;
    return pa - pb;
  });
  return page(c, primaryFirst, null);
});

async function insertTeachersAndPrograms(tx: Tx, orgId: string, classroomId: string, n: Normalized, teacherIds: string[], versionIds: string[]): Promise<void> {
  for (const t of teacherIds) {
    await tx.exec(sql`INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary)
      VALUES (${orgId}, ${classroomId}, ${t}, ${t === n.primary_teacher_id})`);
  }
  for (const v of versionIds) {
    await tx.exec(sql`INSERT INTO app.classroom_programs(org_id, classroom_id, program_version_id) VALUES (${orgId}, ${classroomId}, ${v})`);
  }
}

classroomRoutes.post("/classrooms", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const input = normalize(await readBody(c, ClassroomInput));
  const stored = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      await assertTeachersSelectable(tx, actor.orgId, input, new Set());
      await assertVersionsPublished(tx, actor.orgId, input.program_version_ids);
      await assertNameFree(tx, actor.orgId, input.name, input.starts_on, null);
      const created = await tx.one<{ id: string }>(sql`
        INSERT INTO app.classrooms(org_id, name, capacity, starts_on, ends_on)
        VALUES (${actor.orgId}, ${input.name}, ${input.capacity}, ${input.starts_on}::date, ${input.ends_on}::date) RETURNING id`);
      await insertTeachersAndPrograms(tx, actor.orgId, created.id, input, [input.primary_teacher_id, ...input.assistant_teacher_ids], input.program_version_ids);
      await audit(tx, actor, "classroom.created", created.id, { ...input });
      const classroom = await findClassroom(tx, actor, created.id);
      return { status: 200, body: { data: classroom, checked_at: c.get("deps").now().toISOString() } };
    }),
  );
  if (stored.body.data) c.header("ETag", `"${stored.body.data.row_version}"`);
  return c.json(stored.body);
});

interface ClassroomState {
  name: string;
  capacity: number;
  starts_on: string;
  ends_on: string;
  archived: boolean;
  row_version: number;
}

async function lockClassroom(tx: Tx, orgId: string, id: string): Promise<ClassroomState> {
  const row = await tx.maybeOne<ClassroomState>(sql`
    SELECT name, capacity, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, archived, row_version
    FROM app.classrooms WHERE org_id = ${orgId} AND id = ${id} FOR UPDATE`);
  if (!row) fail("NOT_FOUND");
  return row;
}

async function syncTeachers(tx: Tx, actor: Actor, classroomId: string, input: Normalized, current: { teacher_id: string; is_primary: boolean }[]) {
  const desired = new Set([input.primary_teacher_id, ...input.assistant_teacher_ids]);
  const currentIds = new Set(current.map((r) => r.teacher_id));
  for (const t of currentIds) {
    if (desired.has(t)) continue;
    const usage = await classroomTeacherUsage(tx, actor.orgId, classroomId, t);
    if (usage.students > 0 || usage.slots > 0) {
      fail("CLASSROOM_TEACHER_IN_USE", { details: { teacher_id: t, student_count: usage.students, slot_count: usage.slots } });
    }
    try {
      await tx.exec(sql`DELETE FROM app.classroom_teachers WHERE org_id = ${actor.orgId} AND classroom_id = ${classroomId} AND teacher_id = ${t}`);
    } catch (e) {
      // A lesson slot/student referencing the pair was created concurrently (FK) — same business rule.
      if (isPgError(e, "23503")) throw new ApiError("CLASSROOM_TEACHER_IN_USE", { details: { teacher_id: t }, cause: e });
      throw e;
    }
  }
  // Exactly one primary: clear the previous primary before setting the new one (the unique index is not deferrable).
  await tx.exec(sql`UPDATE app.classroom_teachers SET is_primary = false
    WHERE org_id = ${actor.orgId} AND classroom_id = ${classroomId} AND is_primary AND teacher_id <> ${input.primary_teacher_id}`);
  for (const t of desired) {
    if (currentIds.has(t)) {
      await tx.exec(sql`UPDATE app.classroom_teachers SET is_primary = ${t === input.primary_teacher_id}
        WHERE org_id = ${actor.orgId} AND classroom_id = ${classroomId} AND teacher_id = ${t}`);
    } else {
      await tx.exec(sql`INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary)
        VALUES (${actor.orgId}, ${classroomId}, ${t}, ${t === input.primary_teacher_id})`);
    }
  }
}

classroomRoutes.patch("/classrooms/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = normalize(await readBody(c, ClassroomInput));
  const classroom = await actorTx(c, async (tx) => {
    const before = await lockClassroom(tx, actor.orgId, id);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    if (before.archived) fail("INVALID_STATE", { message_ja: "アーカイブ済みのクラスは編集できません。" });
    const teachers = await tx.query<{ teacher_id: string; is_primary: boolean }>(sql`
      SELECT teacher_id, is_primary FROM app.classroom_teachers WHERE org_id = ${actor.orgId} AND classroom_id = ${id} ORDER BY teacher_id`);
    const versions = (await tx.query<{ program_version_id: string }>(sql`
      SELECT program_version_id FROM app.classroom_programs WHERE org_id = ${actor.orgId} AND classroom_id = ${id} ORDER BY program_version_id`)).map(
      (r) => r.program_version_id,
    );
    await assertTeachersSelectable(tx, actor.orgId, input, new Set(teachers.map((t) => t.teacher_id)));
    await assertVersionsPublished(tx, actor.orgId, input.program_version_ids.filter((v) => !versions.includes(v)));
    await assertNameFree(tx, actor.orgId, input.name, input.starts_on, id);
    // CAPACITY_BELOW_ENROLLMENT is raised by the classroom trigger.
    await tx.exec(sql`UPDATE app.classrooms SET name = ${input.name}, capacity = ${input.capacity}, starts_on = ${input.starts_on}::date,
      ends_on = ${input.ends_on}::date, row_version = row_version + 1 WHERE org_id = ${actor.orgId} AND id = ${id}`);
    await syncTeachers(tx, actor, id, input, teachers);
    const removedVersions = versions.filter((v) => !input.program_version_ids.includes(v));
    if (removedVersions.length) {
      await tx.exec(sql`DELETE FROM app.classroom_programs WHERE org_id = ${actor.orgId} AND classroom_id = ${id} AND program_version_id = ANY(${removedVersions}::uuid[])`);
    }
    await insertTeachersAndPrograms(tx, actor.orgId, id, input, [], input.program_version_ids.filter((v) => !versions.includes(v)));
    const primaryBefore = teachers.find((t) => t.is_primary)?.teacher_id ?? null;
    const changes = diff(
      {
        ...before,
        primary_teacher_id: primaryBefore,
        assistant_teacher_ids: teachers.filter((t) => !t.is_primary).map((t) => t.teacher_id),
        program_version_ids: versions,
      },
      { ...input },
    );
    await audit(tx, actor, "classroom.updated", id, { changes });
    return findClassroom(tx, actor, id);
  });
  if (!classroom) fail("NOT_FOUND");
  return ok(c, classroom, { version: classroom.row_version });
});

/** Archive. The DB trigger refuses while active students are enrolled (CLASSROOM_HAS_STUDENTS). */
classroomRoutes.delete("/classrooms/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const result = await actorTx(c, async (tx) => {
    const before = await lockClassroom(tx, actor.orgId, id);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    if (before.archived) return { row_version: before.row_version };
    const updated = await tx.one<{ row_version: number }>(sql`
      UPDATE app.classrooms SET archived = true, row_version = row_version + 1 WHERE org_id = ${actor.orgId} AND id = ${id} RETURNING row_version`);
    await audit(tx, actor, "classroom.archived", id, { name: before.name, starts_on: before.starts_on });
    return updated;
  });
  c.header("ETag", `"${result.row_version}"`);
  return action(c, { id, archived: true, row_version: result.row_version });
});
