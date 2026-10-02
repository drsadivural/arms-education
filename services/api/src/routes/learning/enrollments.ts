/**
 * Enrollments (受講割当): an explicit admin action that fixes the published program version (and therefore its unit
 * weights and quiz policy) for the student. Students are never enrolled silently when they join a classroom;
 * POST /classrooms/{id}/enrollments is the explicit bulk action for a classroom.
 */
import { Hono } from "hono";
import { ClassroomEnrollmentInput, EnrollmentInput } from "@arms/contracts";
import type { Actor, AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { ApiError, fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { action, ok } from "../../http/respond";
import { pathId, readBody } from "../../http/validation";
import { audit, iso, lockKey, outbox } from "../../domain/learning/common";
import { recomputeStudentProgress } from "../../domain/progress";

export const enrollmentRoutes = new Hono<AppEnv>();

interface VersionInfo {
  id: string;
  program_id: string;
  program_name: string;
  version_number: number;
  state: string;
  archived: boolean;
}

async function publishedVersion(tx: Tx, orgId: string, versionId: string, field = "program_version_id"): Promise<VersionInfo> {
  const v = await tx.maybeOne<VersionInfo>(sql`
    SELECT v.id, v.program_id, p.name AS program_name, v.version_number, v.state, p.archived
    FROM app.program_versions v JOIN app.programs p ON p.org_id = v.org_id AND p.id = v.program_id
    WHERE v.org_id = ${orgId} AND v.id = ${versionId} FOR SHARE OF v`);
  if (!v) throw new ApiError("VALIDATION_FAILED", { field_errors: { [field]: "プログラムのバージョンが見つかりません。" } });
  if (v.archived) fail("PROGRAM_ARCHIVED");
  if (v.state !== "published") fail("VERSION_NOT_PUBLISHED");
  return v;
}

type EnrollOutcome = { created: true; dto: ReturnType<typeof enrollmentDto> } | { created: false; reason: "exists" | "inactive" };

function enrollmentDto(e: { id: string; student_id: string; program_version_id: string; due_on: string; created_at: Date }, v: VersionInfo) {
  return {
    id: e.id,
    student_id: e.student_id,
    program_version_id: e.program_version_id,
    due_on: e.due_on,
    program_id: v.program_id,
    program_name: v.program_name,
    version_number: v.version_number,
    created_at: iso(e.created_at),
  };
}

async function enroll(tx: Tx, actor: Actor, studentId: string, v: VersionInfo, dueOn: string): Promise<EnrollOutcome> {
  await lockKey(tx, `enroll:${actor.orgId}:${studentId}`);
  const student = await tx.maybeOne<{ active: boolean }>(sql`SELECT active FROM app.student_profiles WHERE org_id = ${actor.orgId} AND id = ${studentId}`);
  if (!student) throw new ApiError("VALIDATION_FAILED", { field_errors: { student_id: "新入社員が見つかりません。" } });
  if (!student.active) return { created: false, reason: "inactive" };
  // One enrollment per program: a second version would double-count the same training.
  const existing = await tx.maybeOne(sql`
    SELECT 1 FROM app.enrollments e JOIN app.program_versions ev ON ev.org_id = e.org_id AND ev.id = e.program_version_id
    WHERE e.org_id = ${actor.orgId} AND e.student_id = ${studentId} AND ev.program_id = ${v.program_id}`);
  if (existing) return { created: false, reason: "exists" };
  const e = await tx.one<{ id: string; student_id: string; program_version_id: string; due_on: string; created_at: Date }>(sql`
    INSERT INTO app.enrollments(org_id, student_id, program_version_id, due_on)
    VALUES (${actor.orgId}, ${studentId}, ${v.id}, ${dueOn})
    RETURNING id, student_id, program_version_id, due_on::text AS due_on, created_at`);
  await tx.exec(sql`
    INSERT INTO app.unit_progress(org_id, enrollment_id, program_version_id, unit_id, state)
    SELECT ${actor.orgId}, ${e.id}, ${v.id}, u.id, 'not_started' FROM app.units u WHERE u.org_id = ${actor.orgId} AND u.program_version_id = ${v.id}`);
  await audit(tx, actor.orgId, actor.userId, "enrollment.created", e.id, {
    student_id: studentId,
    program_id: v.program_id,
    program_version_id: v.id,
    version_number: v.version_number,
    due_on: dueOn,
  });
  // History of the student (WEB-12 「…を割当」) is keyed by the student id.
  await audit(tx, actor.orgId, actor.userId, "progress.enrolled", studentId, {
    enrollment_id: e.id,
    program_name: v.program_name,
    version_number: v.version_number,
    due_on: dueOn,
  });
  await outbox(tx, actor.orgId, "enrollment.created", e.id, { student_id: studentId, program_name: v.program_name, due_on: dueOn });
  // Attendance already recorded for slots linked to these units counts immediately.
  await recomputeStudentProgress(tx, actor.orgId, studentId);
  return { created: true, dto: enrollmentDto(e, v) };
}

/** POST /enrollments — admin assigns a published version to one student (unique per student and program). */
enrollmentRoutes.post("/enrollments", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const input = await readBody(c, EnrollmentInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const v = await publishedVersion(tx, actor.orgId, input.program_version_id);
      const outcome = await enroll(tx, actor, input.student_id, v, input.due_on);
      if (!outcome.created) {
        if (outcome.reason === "inactive") throw new ApiError("VALIDATION_FAILED", { field_errors: { student_id: "停止中の新入社員には割り当てできません。" } });
        fail("ENROLLMENT_EXISTS");
      }
      return { status: 200, body: outcome.dto };
    }),
  );
  return ok(c, result.body);
});

/** POST /classrooms/{id}/enrollments — explicit bulk assignment to the classroom's active students. */
enrollmentRoutes.post("/classrooms/:id/enrollments", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const classroomId = pathId(c);
  const input = await readBody(c, ClassroomEnrollmentInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const classroom = await tx.maybeOne(sql`SELECT 1 FROM app.classrooms WHERE org_id = ${actor.orgId} AND id = ${classroomId}`);
      if (!classroom) fail("NOT_FOUND");
      const v = await publishedVersion(tx, actor.orgId, input.program_version_id);
      const students = await tx.query<{ id: string }>(sql`
        SELECT id FROM app.student_profiles WHERE org_id = ${actor.orgId} AND classroom_id = ${classroomId} AND active ORDER BY id`);
      const created: string[] = [];
      let skipped = 0;
      for (const s of students) {
        const outcome = await enroll(tx, actor, s.id, v, input.due_on);
        if (outcome.created) created.push(outcome.dto.id);
        else skipped++;
      }
      return { status: 200, body: { classroom_id: classroomId, program_version_id: v.id, created: created.length, skipped, enrollment_ids: created } };
    }),
  );
  return action(c, result.body);
});
