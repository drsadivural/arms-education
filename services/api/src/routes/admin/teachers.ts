/** WEB-03/04 講師管理: list/read (admin, teacher read-only), create (invitation saga), edit, archive (admin). */
import { Hono } from "hono";
import { TeacherInput, type TeacherInputT } from "@arms/contracts";
import type { AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { fail } from "../../http/errors";
import { pathId, readBody, readQuery, requireIfMatch } from "../../http/validation";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { action, ok, page } from "../../http/respond";
import { ListQuery, TextIdCursor, audit, diff } from "../../domain/admin/common";
import { runInvitation } from "../../domain/admin/invitations";
import { assertCanDeactivate, lockMembership, setMembershipActive, syncProviderBan } from "../../domain/admin/accounts";
import { findTeacher, listTeachers } from "../../repositories/admin/teachers";

export const teacherRoutes = new Hono<AppEnv>();

function normalize(input: TeacherInputT) {
  return {
    display_name: input.display_name,
    kana: input.kana ?? "",
    email: input.email.trim(),
    teacher_number: input.teacher_number,
    department_name: input.department_name,
    specialties: [...new Set(input.specialties ?? [])],
    availability: input.availability ?? null,
    active: input.active,
  };
}
type TeacherPayload = ReturnType<typeof normalize>;

async function assertEmailFree(tx: Tx, email: string): Promise<void> {
  const taken = await tx.maybeOne(sql`SELECT 1 FROM app.users WHERE lower(email) = lower(${email})`);
  if (taken) fail("EMAIL_TAKEN", { field_errors: { email: "このメールアドレスは既に登録されています。" } });
}

async function assertTeacherNumberFree(tx: Tx, orgId: string, teacherNumber: string, exceptId: string | null): Promise<void> {
  const taken = await tx.maybeOne(sql`
    SELECT 1 FROM app.teacher_profiles WHERE org_id = ${orgId} AND teacher_number = ${teacherNumber} AND id IS DISTINCT FROM ${exceptId}::uuid`);
  if (taken) fail("TEACHER_NUMBER_TAKEN", { field_errors: { teacher_number: "この講師番号は既に登録されています。" } });
}

teacherRoutes.get("/teachers", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const query = readQuery(c, ListQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, TextIdCursor);
  const rows = await actorTx(c, (tx) =>
    listTeachers(tx, actor.orgId, {
      q: query.q,
      department: query.department,
      status: query.status,
      classroomId: query.classroom_id,
      after: after ? { k: after.k, id: after.id } : null,
      limit,
    }),
  );
  const { items, nextCursor } = paginate(rows, limit, (t) => ({ k: t.teacher_number, id: t.id }));
  return page(c, items, nextCursor);
});

teacherRoutes.get("/teachers/:id", requireRole("admin", "teacher"), async (c) => {
  const id = pathId(c);
  const teacher = await actorTx(c, (tx) => findTeacher(tx, c.get("actor").orgId, id));
  if (!teacher) fail("NOT_FOUND");
  return ok(c, teacher, { version: teacher.row_version });
});

/** Create = invitation saga (Auth user → DB profile → invitation e-mail), resumable with the same Idempotency-Key. */
teacherRoutes.post("/teachers", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const payload = normalize(await readBody(c, TeacherInput));
  const outcome = await runInvitation(c, {
    email: payload.email,
    role: "teacher",
    displayName: payload.display_name,
    payload,
    async precheck(tx) {
      await assertEmailFree(tx, payload.email);
      await assertTeacherNumberFree(tx, actor.orgId, payload.teacher_number, null);
    },
    async createProfile(tx, stored, userId) {
      const p = stored as TeacherPayload;
      await tx.exec(sql`INSERT INTO app.users(id, display_name, email) VALUES (${userId}, ${p.display_name}, ${p.email})`);
      await tx.exec(sql`INSERT INTO app.memberships(org_id, id, role, active, disabled_at)
        VALUES (${actor.orgId}, ${userId}, 'teacher', ${p.active}, CASE WHEN ${p.active}::boolean THEN NULL ELSE now() END)`);
      await tx.exec(sql`
        INSERT INTO app.teacher_profiles(org_id, id, teacher_number, kana, department_name, specialties, availability)
        VALUES (${actor.orgId}, ${userId}, ${p.teacher_number}, ${p.kana}, ${p.department_name}, ${json(p.specialties)}::jsonb,
          ${json(p.availability ?? {})}::jsonb)`);
      await audit(tx, actor, "teacher.created", userId, {
        teacher_number: p.teacher_number,
        department_name: p.department_name,
        active: p.active,
      });
    },
  });
  const teacher = await actorTx(c, (tx) => findTeacher(tx, actor.orgId, outcome.userId));
  if (!teacher) fail("NOT_FOUND");
  c.header("ETag", `"${teacher.row_version}"`);
  return c.json({ data: teacher, invitation: outcome.result, checked_at: c.get("deps").now().toISOString() });
});

interface TeacherState {
  display_name: string;
  email: string;
  kana: string;
  teacher_number: string;
  department_name: string;
  specialties: string[];
  availability: Record<string, unknown>;
  active: boolean;
  row_version: number;
}

async function lockTeacher(tx: Tx, orgId: string, id: string): Promise<TeacherState> {
  const row = await tx.maybeOne<TeacherState>(sql`
    SELECT u.display_name, u.email, tp.kana, tp.teacher_number, tp.department_name, tp.specialties, tp.availability, m.active, tp.row_version
    FROM app.teacher_profiles tp
    JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id
    JOIN app.users u ON u.id = tp.id
    WHERE tp.org_id = ${orgId} AND tp.id = ${id}
    FOR NO KEY UPDATE OF tp`);
  if (!row) fail("NOT_FOUND");
  return row;
}

teacherRoutes.patch("/teachers/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = normalize(await readBody(c, TeacherInput));
  const result = await actorTx(c, async (tx) => {
    const before = await lockTeacher(tx, actor.orgId, id);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    if (before.email.toLowerCase() !== input.email.toLowerCase()) {
      fail("VALIDATION_FAILED", { field_errors: { email: "メールアドレスはログインIDのため変更できません。別のアカウントとして招待してください。" } });
    }
    await assertTeacherNumberFree(tx, actor.orgId, input.teacher_number, id);
    let activeChanged = false;
    if (before.active !== input.active) {
      const target = await lockMembership(tx, actor.orgId, id);
      if (!input.active) await assertCanDeactivate(tx, actor, target);
      await setMembershipActive(tx, actor.orgId, id, input.active);
      activeChanged = true;
    }
    await tx.exec(sql`UPDATE app.users SET display_name = ${input.display_name} WHERE id = ${id}`);
    const updated = await tx.maybeOne<{ row_version: number }>(sql`
      UPDATE app.teacher_profiles SET teacher_number = ${input.teacher_number}, kana = ${input.kana}, department_name = ${input.department_name},
        specialties = ${json(input.specialties)}::jsonb, availability = ${json(input.availability ?? {})}::jsonb, row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${id} AND row_version = ${expected} RETURNING row_version`);
    if (!updated) fail("VERSION_CONFLICT");
    const changes = diff(
      { ...before, availability: Object.keys(before.availability ?? {}).length ? before.availability : null },
      { display_name: input.display_name, kana: input.kana, teacher_number: input.teacher_number, department_name: input.department_name, specialties: input.specialties, availability: input.availability, active: input.active },
    );
    await audit(tx, actor, input.active || !activeChanged ? "teacher.updated" : "teacher.archived", id, { changes });
    return { activeChanged, teacher: await findTeacher(tx, actor.orgId, id) };
  });
  if (result.activeChanged) await syncProviderBan(c, id, !input.active);
  if (!result.teacher) fail("NOT_FOUND");
  return ok(c, result.teacher, { version: result.teacher.row_version });
});

/** Archive: membership inactive + web sessions revoked; refused while primary teacher or with upcoming slots. */
teacherRoutes.delete("/teachers/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const result = await actorTx(c, async (tx) => {
    const before = await lockTeacher(tx, actor.orgId, id);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    if (!before.active) return { changed: false, row_version: before.row_version };
    const target = await lockMembership(tx, actor.orgId, id);
    await assertCanDeactivate(tx, actor, target);
    await setMembershipActive(tx, actor.orgId, id, false);
    const updated = await tx.one<{ row_version: number }>(sql`
      UPDATE app.teacher_profiles SET row_version = row_version + 1 WHERE org_id = ${actor.orgId} AND id = ${id} RETURNING row_version`);
    await audit(tx, actor, "teacher.archived", id, { teacher_number: before.teacher_number });
    return { changed: true, row_version: updated.row_version };
  });
  const sync = result.changed ? await syncProviderBan(c, id, true) : { provider_synced: true };
  c.header("ETag", `"${result.row_version}"`);
  return action(c, { id, active: false, row_version: result.row_version, ...sync });
});
