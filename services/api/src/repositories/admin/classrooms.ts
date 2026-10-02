/**
 * Classroom read model. student_count is always count(*) of active students computed in SQL (never stored).
 * Teacher scope: classrooms where the teacher is in classroom_teachers (primary or assistant).
 */
import type { Classroom } from "@arms/contracts";
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { and, sql, type SqlFragment } from "../../db/sql";
import { containsPattern } from "../../domain/admin/common";

export function classroomScope(actor: Pick<Actor, "role" | "userId">, alias = sql`c`): SqlFragment {
  if (actor.role === "admin") return sql`TRUE`;
  if (actor.role === "teacher") {
    return sql`EXISTS (SELECT 1 FROM app.classroom_teachers sct WHERE sct.org_id = ${alias}.org_id AND sct.classroom_id = ${alias}.id AND sct.teacher_id = ${actor.userId})`;
  }
  return sql`EXISTS (SELECT 1 FROM app.student_profiles ssp WHERE ssp.org_id = ${alias}.org_id AND ssp.classroom_id = ${alias}.id AND ssp.id = ${actor.userId})`;
}

const CLASSROOM_SELECT = sql`
  SELECT c.id, c.name, c.capacity, to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on,
    c.archived, c.row_version,
    pt.teacher_id AS primary_teacher_id, coalesce(pu.display_name, '') AS primary_teacher_name,
    coalesce((SELECT json_agg(ct.teacher_id ORDER BY ct.teacher_id) FROM app.classroom_teachers ct
      WHERE ct.org_id = c.org_id AND ct.classroom_id = c.id AND NOT ct.is_primary), '[]'::json) AS assistant_teacher_ids,
    coalesce((SELECT json_agg(json_build_object('id', v.id, 'program_id', p.id, 'name', p.name, 'version_number', v.version_number)
        ORDER BY p.name, v.version_number)
      FROM app.classroom_programs cp
      JOIN app.program_versions v ON v.org_id = cp.org_id AND v.id = cp.program_version_id
      JOIN app.programs p ON p.org_id = v.org_id AND p.id = v.program_id
      WHERE cp.org_id = c.org_id AND cp.classroom_id = c.id), '[]'::json) AS programs,
    (SELECT count(*)::int FROM app.student_profiles sp WHERE sp.org_id = c.org_id AND sp.classroom_id = c.id AND sp.active) AS student_count,
    (SELECT round(avg(x.p))::int FROM (
       SELECT avg(ep.progress_percent) AS p FROM app.student_profiles sp
       JOIN app.enrollment_progress ep ON ep.org_id = sp.org_id AND ep.student_id = sp.id
       WHERE sp.org_id = c.org_id AND sp.classroom_id = c.id AND sp.active GROUP BY sp.id) x) AS average_progress_percent
  FROM app.classrooms c
  LEFT JOIN app.classroom_teachers pt ON pt.org_id = c.org_id AND pt.classroom_id = c.id AND pt.is_primary
  LEFT JOIN app.users pu ON pu.id = pt.teacher_id`;

interface ClassroomRow extends Omit<Classroom, "program_version_ids"> {
  programs: Classroom["programs"];
}

const toClassroom = (r: ClassroomRow): Classroom => ({ ...r, program_version_ids: r.programs.map((p) => p.id) });

export async function findClassroom(tx: Tx, actor: Pick<Actor, "orgId" | "role" | "userId">, id: string): Promise<Classroom | null> {
  const row = await tx.maybeOne<ClassroomRow>(sql`${CLASSROOM_SELECT} WHERE c.org_id = ${actor.orgId} AND c.id = ${id} AND ${classroomScope(actor)}`);
  return row ? toClassroom(row) : null;
}

export interface ClassroomListFilter {
  q?: string;
  status?: "active" | "archived";
  teacherId?: string;
  after?: { d: string; name: string; id: string } | null;
  limit: number;
}

/** Newest training period first, then by name. */
export async function listClassrooms(tx: Tx, actor: Pick<Actor, "orgId" | "role" | "userId">, f: ClassroomListFilter): Promise<Classroom[]> {
  const where = and([
    sql`c.org_id = ${actor.orgId}`,
    classroomScope(actor),
    f.q ? sql`c.name ILIKE ${containsPattern(f.q)} ESCAPE '\\'` : null,
    f.status === "active" ? sql`NOT c.archived` : f.status === "archived" ? sql`c.archived` : null,
    f.teacherId
      ? sql`EXISTS (SELECT 1 FROM app.classroom_teachers ft WHERE ft.org_id = c.org_id AND ft.classroom_id = c.id AND ft.teacher_id = ${f.teacherId})`
      : null,
    f.after
      ? sql`(c.starts_on < ${f.after.d}::date OR (c.starts_on = ${f.after.d}::date AND (c.name, c.id) > (${f.after.name}, ${f.after.id}::uuid)))`
      : null,
  ]);
  const rows = await tx.query<ClassroomRow>(sql`${CLASSROOM_SELECT} WHERE ${where} ORDER BY c.starts_on DESC, c.name, c.id LIMIT ${f.limit + 1}`);
  return rows.map(toClassroom);
}

/** Students (any state) and lesson slots (any state) that reference the classroom–teacher pair. */
export async function classroomTeacherUsage(tx: Tx, orgId: string, classroomId: string, teacherId: string): Promise<{ students: number; slots: number }> {
  return tx.one(sql`
    SELECT (SELECT count(*)::int FROM app.student_profiles WHERE org_id = ${orgId} AND classroom_id = ${classroomId} AND teacher_id = ${teacherId}) AS students,
           (SELECT count(*)::int FROM app.lesson_slots WHERE org_id = ${orgId} AND classroom_id = ${classroomId} AND teacher_id = ${teacherId}) AS slots`);
}
