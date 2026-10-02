/**
 * Legacy 社員教育進捗管理 records (WEB-11/12). Columns are kept exactly as in assets/reference/legacy-progress.png:
 * 終了予定日 due_date, 社員名, 教育担当部署 department_name (snapshot), 教育担当者 teacher name snapshot, 内容 content.
 * 期限超過 is derived (due_date < organisation-local today and not completed) — never stored, never UTC-truncated.
 * Shared by the list endpoint and the CSV/PDF export so both apply identical filters and teacher scope.
 */
import { zonedMonthRange } from "@arms/contracts";
import type { Actor } from "../../context";
import { and, sql, type SqlFragment } from "../../db/sql";
import { studentProgressJoin } from "../progress";
import { dateOnly, iso, likePattern, teacherStudentScope } from "./common";

export interface RecordFilters {
  month?: string;
  from?: string;
  to?: string;
  department?: string;
  teacher_id?: string;
  classroom_id?: string;
  student_id?: string;
  status?: "unverified" | "not_started" | "in_progress" | "review_pending" | "completed" | "overdue";
  q?: string;
}

export function recordSelect(today: string): SqlFragment {
  return sql`
    SELECT pr.id, pr.student_id, pr.teacher_id, pr.department_name, pr.due_date::text AS due_date, pr.content, pr.notes, pr.state,
           pr.row_version, pr.created_at, pr.updated_at, pr.teacher_name_snapshot AS teacher_name,
           su.display_name AS student_name, sp.employee_number, sp.classroom_id, c.name AS classroom_name,
           prog.pct AS progress_percent, (pr.state <> 'completed' AND pr.due_date < ${today}::date) AS overdue
    FROM app.progress_records pr
    JOIN app.student_profiles sp ON sp.org_id = pr.org_id AND sp.id = pr.student_id
    JOIN app.users su ON su.id = pr.student_id
    LEFT JOIN app.classrooms c ON c.org_id = sp.org_id AND c.id = sp.classroom_id
    ${studentProgressJoin("pr.student_id")}`;
}

/** Teachers see records they are the 教育担当者 of, and records of students they teach (担当講師/クラス担当). */
export function recordScope(actor: Actor): SqlFragment | false {
  if (actor.role !== "teacher") return false;
  return sql`(pr.teacher_id = ${actor.userId} OR ${teacherStudentScope("sp", actor.userId)})`;
}

export function recordWhere(actor: Actor, f: RecordFilters, today: string): SqlFragment {
  const month = f.month ? zonedMonthRange(f.month, actor.timezone) : null;
  return and([
    sql`pr.org_id = ${actor.orgId}`,
    recordScope(actor),
    month && sql`pr.due_date BETWEEN ${month.firstDay}::date AND ${month.lastDay}::date`,
    !!f.from && sql`pr.due_date >= ${f.from}::date`,
    !!f.to && sql`pr.due_date <= ${f.to}::date`,
    !!f.department && sql`pr.department_name = ${f.department}`,
    !!f.teacher_id && sql`pr.teacher_id = ${f.teacher_id}`,
    !!f.classroom_id && sql`sp.classroom_id = ${f.classroom_id}`,
    !!f.student_id && sql`pr.student_id = ${f.student_id}`,
    f.status === "overdue" && sql`(pr.state <> 'completed' AND pr.due_date < ${today}::date)`,
    !!f.status && f.status !== "overdue" && sql`pr.state = ${f.status}`,
    !!f.q && sql`(su.display_name ILIKE ${likePattern(f.q)} OR sp.kana ILIKE ${likePattern(f.q)} OR pr.content ILIKE ${likePattern(f.q)} OR sp.employee_number = ${f.q})`,
  ]);
}

export interface RecordRow {
  id: string;
  student_id: string;
  teacher_id: string;
  department_name: string;
  due_date: string;
  content: string;
  notes: string;
  state: "unverified" | "not_started" | "in_progress" | "review_pending" | "completed";
  row_version: number;
  created_at: Date;
  updated_at: Date;
  teacher_name: string;
  student_name: string;
  employee_number: string;
  classroom_id: string | null;
  classroom_name: string | null;
  progress_percent: number | null;
  overdue: boolean;
}

export function recordDto(r: RecordRow) {
  return {
    id: r.id,
    student_id: r.student_id,
    teacher_id: r.teacher_id,
    department_name: r.department_name,
    due_date: dateOnly(r.due_date),
    content: r.content,
    notes: r.notes,
    state: r.state,
    student_name: r.student_name,
    teacher_name: r.teacher_name,
    progress_percent: r.progress_percent === null ? null : Number(r.progress_percent),
    row_version: r.row_version,
    overdue: r.overdue,
    employee_number: r.employee_number,
    classroom_id: r.classroom_id,
    classroom_name: r.classroom_name,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export const RECORD_ORDER = sql`ORDER BY pr.due_date, su.display_name, pr.id`;
