/**
 * Student read model and the teacher scope rule.
 *
 * Scope: an admin sees every student of the organisation. A teacher sees a student when
 *   student_profiles.teacher_id = the teacher, OR the student's classroom has the teacher in classroom_teachers.
 * Out-of-scope single reads are reported as 404 by the routes.
 */
import type { Student } from "@arms/contracts";
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { and, sql, type SqlFragment } from "../../db/sql";
import { containsPattern } from "../../domain/admin/common";
import { latestInvitationState, type InvitationState } from "./teachers";

/** SQL condition restricting `sp` (app.student_profiles) to the actor's scope. */
export function studentScope(actor: Pick<Actor, "role" | "userId">, alias = sql`sp`): SqlFragment {
  if (actor.role === "admin") return sql`TRUE`;
  if (actor.role === "teacher") {
    return sql`(${alias}.teacher_id = ${actor.userId} OR EXISTS (
      SELECT 1 FROM app.classroom_teachers sct
      WHERE sct.org_id = ${alias}.org_id AND sct.classroom_id = ${alias}.classroom_id AND sct.teacher_id = ${actor.userId}))`;
  }
  return sql`${alias}.id = ${actor.userId}`;
}

/** Average of the student's enrollment progress (app.enrollment_progress), rounded; null without enrollments. */
export const studentProgress = (alias: SqlFragment) => sql`(
  SELECT round(avg(ep.progress_percent))::int FROM app.enrollment_progress ep
  WHERE ep.org_id = ${alias}.org_id AND ep.student_id = ${alias}.id)`;

interface StudentRow extends Omit<Student, "invitation_state"> {
  invitation_state: InvitationState | null;
}

const STUDENT_SELECT = sql`
  SELECT sp.id, sp.employee_number, u.display_name, sp.kana, u.email, sp.company_name, sp.department_name,
    to_char(sp.joined_on, 'YYYY-MM-DD') AS joined_on,
    sp.classroom_id, c.name AS classroom_name, sp.teacher_id, tu.display_name AS teacher_name,
    to_char(sp.training_starts_on, 'YYYY-MM-DD') AS training_starts_on,
    to_char(sp.training_due_on, 'YYYY-MM-DD') AS training_due_on,
    sp.active, sp.row_version,
    ${studentProgress(sql`sp`)} AS progress_percent,
    ${latestInvitationState(sql`sp.org_id`, sql`sp.id`)} AS invitation_state
  FROM app.student_profiles sp
  JOIN app.users u ON u.id = sp.id
  JOIN app.classrooms c ON c.org_id = sp.org_id AND c.id = sp.classroom_id
  JOIN app.users tu ON tu.id = sp.teacher_id`;

export async function findStudent(tx: Tx, actor: Pick<Actor, "orgId" | "role" | "userId">, id: string): Promise<Student | null> {
  return tx.maybeOne<StudentRow>(sql`${STUDENT_SELECT} WHERE sp.org_id = ${actor.orgId} AND sp.id = ${id} AND ${studentScope(actor)}`);
}

export interface StudentListFilter {
  q?: string;
  classroomId?: string;
  teacherId?: string;
  department?: string;
  status?: "active" | "inactive";
  after?: { k: string; id: string } | null;
  limit: number;
}

export async function listStudents(tx: Tx, actor: Pick<Actor, "orgId" | "role" | "userId">, f: StudentListFilter): Promise<Student[]> {
  const like = f.q ? containsPattern(f.q) : null;
  const where = and([
    sql`sp.org_id = ${actor.orgId}`,
    studentScope(actor),
    like
      ? sql`(u.display_name ILIKE ${like} ESCAPE '\\' OR sp.kana ILIKE ${like} ESCAPE '\\'
          OR sp.employee_number ILIKE ${like} ESCAPE '\\' OR u.email ILIKE ${like} ESCAPE '\\')`
      : null,
    f.classroomId ? sql`sp.classroom_id = ${f.classroomId}` : null,
    f.teacherId ? sql`sp.teacher_id = ${f.teacherId}` : null,
    f.department ? sql`sp.department_name = ${f.department}` : null,
    f.status === "active" ? sql`sp.active` : f.status === "inactive" ? sql`NOT sp.active` : null,
    f.after ? sql`(sp.employee_number, sp.id) > (${f.after.k}, ${f.after.id}::uuid)` : null,
  ]);
  return tx.query<StudentRow>(sql`${STUDENT_SELECT} WHERE ${where} ORDER BY sp.employee_number, sp.id LIMIT ${f.limit + 1}`);
}

/**
 * Seat-holding reservations of the student whose lesson has not ended (blocks withdrawal):
 * approved, or pending within its hold period (an elapsed pending no longer holds a seat).
 */
export async function activeReservationCount(tx: Tx, orgId: string, studentId: string): Promise<number> {
  const row = await tx.one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM app.reservations
    WHERE org_id = ${orgId} AND student_id = ${studentId} AND ends_at > now()
      AND (status = 'approved' OR (status = 'pending' AND expires_at > now()))`);
  return row.n;
}
