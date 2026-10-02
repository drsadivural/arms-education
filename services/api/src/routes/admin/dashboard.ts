/**
 * WEB-02 ダッシュボード (admin: organisation; teacher: own scope).
 *
 * - student_count: active students (student_profiles.active) in scope.
 * - average_progress_percent: per student, the mean of app.enrollment_progress over the student's enrollments;
 *   then the mean over students, rounded (students without enrollments are excluded; null when none).
 * - pending_reservation_count / pending_reservations (latest 5): status pending and still within expires_at.
 *   Teachers: reservations of their own lesson slots (the ones they decide).
 * - today_lessons: non-cancelled slots starting on the organisation-local (JST) today. Teachers: own slots.
 *   meeting_url is returned to admins and to the slot's teacher only.
 * - progress_trend: last 6 months including the current one. For month M the cut-off is the end of M in the
 *   organisation timezone (now for the current month). For every enrollment created before the cut-off:
 *   100 × Σ weight(required units completed with completed_at < cut-off) / Σ weight(required units);
 *   averaged per student, then across students and rounded. Units that are not completed now count as not
 *   completed in earlier months (unit_progress keeps the current state only).
 * Filters: department (student department → students, progress, pending reservations) and classroom_id (all).
 */
import { Hono } from "hono";
import { z } from "zod";
import { addMonths, zId, zonedDateString, zonedDayRange, zonedMonthRange, type Dashboard, type LessonSlot, type Reservation } from "@arms/contracts";
import type { AppEnv } from "../../context";
import { actorTx } from "../../context";
import { and, sql, type SqlFragment } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { readQuery } from "../../http/validation";
import { ok } from "../../http/respond";
import { optionalQuery, zQueryText } from "../../domain/admin/common";
import { studentScope } from "../../repositories/admin/students";

export const dashboardRoutes = new Hono<AppEnv>();

const DashboardQuery = z.object({ department: optionalQuery(zQueryText), classroom_id: optionalQuery(zId) });

const TODAY_LESSON_LIMIT = 50;

dashboardRoutes.get("/dashboard", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const now = c.get("deps").now();
  const query = readQuery(c, DashboardQuery);
  const tz = actor.timezone;
  const today = zonedDateString(now, tz);
  const day = zonedDayRange(today, tz);
  const currentMonth = today.slice(0, 7);
  const months = Array.from({ length: 6 }, (_, i) => addMonths(currentMonth, i - 5));
  const cutoffs = months.map((m) => {
    const end = zonedMonthRange(m, tz).end;
    return (end > now ? now : end).toISOString();
  });
  const isTeacher = actor.role === "teacher";

  const studentWhere = and([
    sql`sp.org_id = ${actor.orgId}`,
    sql`sp.active`,
    studentScope(actor),
    query.department ? sql`sp.department_name = ${query.department}` : null,
    query.classroom_id ? sql`sp.classroom_id = ${query.classroom_id}` : null,
  ]);
  const slotWhere = (alias: SqlFragment) =>
    and([
      sql`${alias}.org_id = ${actor.orgId}`,
      isTeacher ? sql`${alias}.teacher_id = ${actor.userId}` : null,
      query.classroom_id ? sql`${alias}.classroom_id = ${query.classroom_id}` : null,
    ]);
  const pendingWhere = and([
    slotWhere(sql`s`),
    sql`r.status = 'pending'`,
    sql`r.expires_at > ${now}`,
    query.department ? sql`sp.department_name = ${query.department}` : null,
  ]);

  const data = await actorTx(c, async (tx) => {
    const counts = await tx.one<{ student_count: number; average: number | null; pending: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM app.student_profiles sp WHERE ${studentWhere}) AS student_count,
        (SELECT round(avg(x.p))::int FROM (
           SELECT avg(ep.progress_percent) AS p FROM app.student_profiles sp
           JOIN app.enrollment_progress ep ON ep.org_id = sp.org_id AND ep.student_id = sp.id
           WHERE ${studentWhere} GROUP BY sp.id) x) AS average,
        (SELECT count(*)::int FROM app.reservations r
           JOIN app.lesson_slots s ON s.org_id = r.org_id AND s.id = r.slot_id
           JOIN app.student_profiles sp ON sp.org_id = r.org_id AND sp.id = r.student_id
           WHERE ${pendingWhere}) AS pending`);

    const lessons = await tx.query<{
      id: string;
      classroom_id: string;
      teacher_id: string;
      unit_id: string | null;
      title: string;
      starts_at: Date;
      ends_at: Date;
      capacity: number;
      booking_closes_at: Date;
      meeting_url: string | null;
      cancel_before_seconds: number;
      teacher_name: string;
      classroom_name: string;
      state: LessonSlot["state"];
      row_version: number;
      pending_count: number;
      approved_count: number;
      total: number;
    }>(sql`
      SELECT s.id, s.classroom_id, s.teacher_id, s.unit_id, s.title, s.starts_at, s.ends_at, s.capacity, s.booking_closes_at, s.meeting_url,
        s.cancel_before_seconds, tu.display_name AS teacher_name, cl.name AS classroom_name, s.state, s.row_version,
        (SELECT count(*)::int FROM app.reservations r WHERE r.org_id = s.org_id AND r.slot_id = s.id AND r.status = 'pending' AND r.expires_at > ${now}) AS pending_count,
        (SELECT count(*)::int FROM app.reservations r WHERE r.org_id = s.org_id AND r.slot_id = s.id AND r.status = 'approved') AS approved_count,
        count(*) OVER ()::int AS total
      FROM app.lesson_slots s
      JOIN app.users tu ON tu.id = s.teacher_id
      JOIN app.classrooms cl ON cl.org_id = s.org_id AND cl.id = s.classroom_id
      WHERE ${slotWhere(sql`s`)} AND s.state <> 'cancelled' AND s.starts_at >= ${day.start} AND s.starts_at < ${day.end}
      ORDER BY s.starts_at, s.id LIMIT ${TODAY_LESSON_LIMIT}`);

    const pending = await tx.query<{
      id: string;
      slot_id: string;
      student_id: string;
      status: Reservation["status"];
      starts_at: Date;
      ends_at: Date;
      expires_at: Date;
      row_version: number;
      reason: string | null;
      student_name: string;
      employee_number: string;
      slot_title: string;
      teacher_id: string;
      teacher_name: string;
      classroom_id: string;
      classroom_name: string;
      cancel_before_seconds: number;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      SELECT r.id, r.slot_id, r.student_id, r.status, r.starts_at, r.ends_at, r.expires_at, r.row_version, r.reason,
        su.display_name AS student_name, sp.employee_number, s.title AS slot_title, s.teacher_id, tu.display_name AS teacher_name,
        s.classroom_id, cl.name AS classroom_name, s.cancel_before_seconds, r.created_at, r.updated_at
      FROM app.reservations r
      JOIN app.lesson_slots s ON s.org_id = r.org_id AND s.id = r.slot_id
      JOIN app.student_profiles sp ON sp.org_id = r.org_id AND sp.id = r.student_id
      JOIN app.users su ON su.id = r.student_id
      JOIN app.users tu ON tu.id = s.teacher_id
      JOIN app.classrooms cl ON cl.org_id = s.org_id AND cl.id = s.classroom_id
      WHERE ${pendingWhere}
      ORDER BY r.created_at DESC, r.id DESC LIMIT 5`);

    const trend = await tx.query<{ month: string; percent: number | null }>(sql`
      WITH months AS (
        SELECT m.month, m.cutoff, m.idx FROM unnest(${months}::text[], ${cutoffs}::timestamptz[]) WITH ORDINALITY AS m(month, cutoff, idx)
      ),
      students AS (SELECT sp.id FROM app.student_profiles sp WHERE ${studentWhere}),
      weights AS (
        SELECT u.program_version_id, sum(u.weight) AS total FROM app.units u WHERE u.org_id = ${actor.orgId} AND u.required
        GROUP BY u.program_version_id HAVING sum(u.weight) > 0
      ),
      per_enrollment AS (
        SELECT mo.month, e.student_id,
          100.0 * coalesce((
            SELECT sum(u.weight) FROM app.unit_progress p
            JOIN app.units u ON u.org_id = p.org_id AND u.id = p.unit_id AND u.required
            WHERE p.org_id = e.org_id AND p.enrollment_id = e.id AND p.state = 'completed' AND p.completed_at < mo.cutoff), 0) / w.total AS pct
        FROM months mo
        JOIN app.enrollments e ON e.org_id = ${actor.orgId} AND e.created_at < mo.cutoff
        JOIN students st ON st.id = e.student_id
        JOIN weights w ON w.program_version_id = e.program_version_id
      ),
      per_student AS (SELECT month, student_id, avg(pct) AS pct FROM per_enrollment GROUP BY month, student_id)
      SELECT mo.month, round(avg(ps.pct))::int AS percent
      FROM months mo LEFT JOIN per_student ps ON ps.month = mo.month
      GROUP BY mo.idx, mo.month ORDER BY mo.idx`);

    return { counts, lessons, pending, trend };
  });

  const checkedAt = now.toISOString();
  const todayLessons: LessonSlot[] = data.lessons.map((s) => {
    const canSeeUrl = actor.role === "admin" || s.teacher_id === actor.userId;
    return {
      id: s.id,
      classroom_id: s.classroom_id,
      teacher_id: s.teacher_id,
      unit_id: s.unit_id,
      title: s.title,
      starts_at: s.starts_at.toISOString(),
      ends_at: s.ends_at.toISOString(),
      capacity: s.capacity,
      booking_closes_at: s.booking_closes_at.toISOString(),
      meeting_url: canSeeUrl ? s.meeting_url : null,
      has_meeting_url: s.meeting_url !== null,
      cancel_before_seconds: s.cancel_before_seconds,
      teacher_name: s.teacher_name,
      classroom_name: s.classroom_name,
      remaining: Math.max(0, s.capacity - s.pending_count - s.approved_count),
      pending_count: s.pending_count,
      approved_count: s.approved_count,
      state: s.state,
      row_version: s.row_version,
    };
  });
  const pendingReservations: Reservation[] = data.pending.map((r) => ({
    id: r.id,
    slot_id: r.slot_id,
    student_id: r.student_id,
    status: r.status,
    starts_at: r.starts_at.toISOString(),
    ends_at: r.ends_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
    row_version: r.row_version,
    reason: r.reason,
    student_name: r.student_name,
    employee_number: r.employee_number,
    slot_title: r.slot_title,
    teacher_id: r.teacher_id,
    teacher_name: r.teacher_name,
    classroom_id: r.classroom_id,
    classroom_name: r.classroom_name,
    meeting_url: null,
    cancel_deadline: new Date(r.starts_at.getTime() - r.cancel_before_seconds * 1000).toISOString(),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    checked_at: checkedAt,
  }));
  const dashboard: Dashboard = {
    student_count: data.counts.student_count,
    average_progress_percent: data.counts.average,
    pending_reservation_count: data.counts.pending,
    today_lesson_count: data.lessons[0]?.total ?? 0,
    progress_trend: data.trend.map((t) => ({ month: t.month, percent: t.percent })),
    today_lessons: todayLessons,
    pending_reservations: pendingReservations,
  };
  return ok(c, dashboard);
});
