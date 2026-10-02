/**
 * Teacher read model. classroom_ids / student_count / invitation_state are computed in SQL on every read.
 * Teachers may read every teacher of their organisation (read-only); writes are admin-only (routes).
 */
import { WeeklyHours, type Teacher } from "@arms/contracts";
import type { Tx } from "../../db/client";
import { and, sql, type SqlFragment } from "../../db/sql";
import { containsPattern } from "../../domain/admin/common";

export type InvitationState = "pending" | "auth_created" | "profile_created" | "sent" | "failed";

interface TeacherRow {
  id: string;
  display_name: string;
  kana: string;
  email: string;
  teacher_number: string;
  department_name: string;
  specialties: unknown;
  availability: unknown;
  classrooms: { id: string; name: string; is_primary: boolean }[];
  student_count: number;
  active: boolean;
  invitation_state: InvitationState | null;
  row_version: number;
}

/** Latest invitation job state of a user (null when the account was not created through an invitation). */
export const latestInvitationState = (orgCol: SqlFragment, userCol: SqlFragment) => sql`(
  SELECT j.state FROM app.invitation_jobs j WHERE j.org_id = ${orgCol} AND j.auth_user_id = ${userCol}
  ORDER BY j.created_at DESC, j.id DESC LIMIT 1)`;

const TEACHER_SELECT = sql`
  SELECT tp.id, u.display_name, tp.kana, u.email, tp.teacher_number, tp.department_name, tp.specialties, tp.availability,
    m.active, tp.row_version,
    coalesce((
      SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'is_primary', ct.is_primary) ORDER BY ct.is_primary DESC, c.starts_on DESC, c.name, c.id)
      FROM app.classroom_teachers ct
      JOIN app.classrooms c ON c.org_id = ct.org_id AND c.id = ct.classroom_id AND NOT c.archived
      WHERE ct.org_id = tp.org_id AND ct.teacher_id = tp.id), '[]'::json) AS classrooms,
    (SELECT count(*)::int FROM app.student_profiles sp WHERE sp.org_id = tp.org_id AND sp.teacher_id = tp.id AND sp.active) AS student_count,
    ${latestInvitationState(sql`tp.org_id`, sql`tp.id`)} AS invitation_state
  FROM app.teacher_profiles tp
  JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id
  JOIN app.users u ON u.id = tp.id`;

function toTeacher(r: TeacherRow): Teacher {
  const availability = WeeklyHours.safeParse(r.availability);
  const specialties = Array.isArray(r.specialties) ? r.specialties.filter((s): s is string => typeof s === "string") : [];
  return {
    id: r.id,
    display_name: r.display_name,
    kana: r.kana,
    email: r.email,
    teacher_number: r.teacher_number,
    department_name: r.department_name,
    specialties,
    availability: availability.success ? availability.data : null,
    classroom_ids: r.classrooms.map((c) => c.id),
    classrooms: r.classrooms,
    student_count: r.student_count,
    active: r.active,
    invitation_state: r.invitation_state,
    row_version: r.row_version,
  };
}

export async function findTeacher(tx: Tx, orgId: string, id: string): Promise<Teacher | null> {
  const row = await tx.maybeOne<TeacherRow>(sql`${TEACHER_SELECT} WHERE tp.org_id = ${orgId} AND tp.id = ${id}`);
  return row ? toTeacher(row) : null;
}

export interface TeacherListFilter {
  q?: string;
  department?: string;
  status?: "active" | "inactive";
  classroomId?: string;
  /** Only teachers assigned to this classroom and active (selectable in the student form). */
  selectableInClassroom?: string;
  after?: { k: string; id: string } | null;
  limit: number;
}

export async function listTeachers(tx: Tx, orgId: string, f: TeacherListFilter): Promise<Teacher[]> {
  const where = and([
    sql`tp.org_id = ${orgId}`,
    f.q
      ? sql`(u.display_name ILIKE ${containsPattern(f.q)} ESCAPE '\\' OR tp.kana ILIKE ${containsPattern(f.q)} ESCAPE '\\'
          OR u.email ILIKE ${containsPattern(f.q)} ESCAPE '\\' OR tp.teacher_number ILIKE ${containsPattern(f.q)} ESCAPE '\\')`
      : null,
    f.department ? sql`tp.department_name = ${f.department}` : null,
    f.status === "active" ? sql`m.active` : f.status === "inactive" ? sql`NOT m.active` : null,
    f.classroomId
      ? sql`EXISTS (SELECT 1 FROM app.classroom_teachers ct WHERE ct.org_id = tp.org_id AND ct.classroom_id = ${f.classroomId} AND ct.teacher_id = tp.id)`
      : null,
    f.selectableInClassroom
      ? sql`m.active AND EXISTS (SELECT 1 FROM app.classroom_teachers ct WHERE ct.org_id = tp.org_id AND ct.classroom_id = ${f.selectableInClassroom} AND ct.teacher_id = tp.id)`
      : null,
    f.after ? sql`(tp.teacher_number, tp.id) > (${f.after.k}, ${f.after.id}::uuid)` : null,
  ]);
  const rows = await tx.query<TeacherRow>(sql`${TEACHER_SELECT} WHERE ${where} ORDER BY tp.teacher_number, tp.id LIMIT ${f.limit + 1}`);
  return rows.map(toTeacher);
}

/** Classrooms (not archived) where the teacher is the primary teacher. */
export async function primaryClassroomsOf(tx: Tx, orgId: string, teacherId: string): Promise<{ id: string; name: string }[]> {
  return tx.query(sql`
    SELECT c.id, c.name FROM app.classroom_teachers ct
    JOIN app.classrooms c ON c.org_id = ct.org_id AND c.id = ct.classroom_id
    WHERE ct.org_id = ${orgId} AND ct.teacher_id = ${teacherId} AND ct.is_primary AND NOT c.archived
    ORDER BY c.name`);
}

/** Scheduled (not cancelled) lesson slots of the teacher that have not ended yet. */
export async function upcomingSlotCount(tx: Tx, orgId: string, teacherId: string): Promise<number> {
  const row = await tx.one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM app.lesson_slots
    WHERE org_id = ${orgId} AND teacher_id = ${teacherId} AND state IN ('open', 'closed') AND ends_at > now()`);
  return row.n;
}
