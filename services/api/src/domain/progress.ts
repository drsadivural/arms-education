/**
 * Progress service shared by Web, iOS and the voice assistant (docs/04 「進捗の計算」). Owned by the learning module.
 *
 * Unit completion (published version fixed on the enrollment) requires ALL of:
 *  - every required PDF/動画/画像/リンク material confirmed by the student (material_receipts),
 *  - every required quiz passed: the version policy picks the highest or the latest attempt score, and it must be
 *    ≥ unit.pass_score (null pass_score → 100 = 全問正解),
 *  - every required assignment accepted by a teacher when unit.requires_review (otherwise submitted is enough),
 *  - attendance present/late in a lesson slot linked to the unit when unit.required_attendance.
 * A unit with no completion condition, or whose only evidence would be a self-reported video view, never completes
 * (publishing rejects such units; this is the defensive runtime invariant).
 * States: not_started → in_progress (any activity) → review_pending (only teacher review outstanding) → completed.
 * progress_percent = round(completed required weight / required weight × 100) across all enrollments; optional
 * units are excluded from both numerator and denominator; no required units → null (「未設定」).
 */
import type { Tx } from "../db/client";
import { json } from "../db/client";
import { ident, sql, type SqlFragment } from "../db/sql";
import { isoOrNull, lockKey, num, numOrNull } from "./learning/common";

export type UnitState = "not_started" | "in_progress" | "review_pending" | "completed";
export type SubmissionState = "submitted" | "accepted" | "revision_requested";

export interface VersionPolicy {
  max_quiz_attempts: number;
  quiz_score_policy: "highest" | "latest";
}

/** Used only for versions created before a policy existed (all API-created versions store one). */
export const DEFAULT_POLICY: VersionPolicy = { max_quiz_attempts: 3, quiz_score_policy: "highest" };
/** Pass score applied when a unit has no explicit pass_score. */
export const DEFAULT_PASS_SCORE = 100;

export function parsePolicy(raw: unknown): VersionPolicy {
  const p = (raw ?? {}) as Partial<VersionPolicy>;
  return {
    max_quiz_attempts: Number.isInteger(p.max_quiz_attempts) && (p.max_quiz_attempts as number) > 0 ? (p.max_quiz_attempts as number) : DEFAULT_POLICY.max_quiz_attempts,
    quiz_score_policy: p.quiz_score_policy === "latest" ? "latest" : p.quiz_score_policy === "highest" ? "highest" : DEFAULT_POLICY.quiz_score_policy,
  };
}

export function effectivePassScore(passScore: number | null): number {
  return passScore === null ? DEFAULT_PASS_SCORE : passScore;
}

/** Score that counts under the version policy (null when there is no attempt). */
export function effectiveQuizScore(policy: VersionPolicy, highest: number | null, latest: number | null): number | null {
  return policy.quiz_score_policy === "latest" ? latest : highest;
}

/** round(completed / total × 100) using integer weight cents (weights are numeric(10,2)); null when total is 0. */
export function progressPercent(completedCents: number, totalCents: number): number | null {
  if (totalCents <= 0) return null;
  return Math.round((100 * completedCents) / totalCents);
}

const toCents = (w: number) => Math.round(w * 100);

interface EnrollmentRow {
  enrollment_id: string;
  program_version_id: string;
  due_on: string;
  policy: unknown;
  version_number: number;
  program_id: string;
  program_name: string;
}
interface UnitRow {
  id: string;
  program_version_id: string;
  title: string;
  position: number;
  required: boolean;
  weight: string;
  pass_score: string | null;
  required_attendance: boolean;
  requires_review: boolean;
}
interface MaterialEvidenceRow {
  id: string;
  unit_id: string;
  kind: string;
  required: boolean;
  confirmed: boolean;
  attempts: string | null;
  max_score: string | null;
  latest_score: string | null;
  submission_state: SubmissionState | null;
  feedback: string | null;
}
interface StoredUnitRow {
  enrollment_id: string;
  unit_id: string;
  state: UnitState;
  completed_at: Date | null;
}

export interface UnitEvaluation {
  enrollmentId: string;
  programVersionId: string;
  programName: string;
  unitId: string;
  title: string;
  position: number;
  required: boolean;
  weight: number;
  requiresReview: boolean;
  requiredAttendance: boolean;
  passScore: number;
  materialsTotal: number;
  materialsConfirmed: number;
  quizPassed: boolean | null;
  score: number | null;
  submissionState: SubmissionState | null;
  feedback: string | null;
  attendanceSatisfied: boolean;
  state: UnitState;
}

export interface StudentEvaluation {
  enrollments: (EnrollmentRow & { policy: VersionPolicy })[];
  units: UnitEvaluation[];
  stored: Map<string, StoredUnitRow>;
}

const VIEWABLE = new Set(["pdf", "video", "image", "link"]);

function aggregateSubmission(states: (SubmissionState | null)[]): SubmissionState | null {
  if (states.length === 0) return null;
  if (states.includes("revision_requested")) return "revision_requested";
  if (states.includes("submitted")) return "submitted";
  if (states.every((s) => s === "accepted")) return "accepted";
  return null;
}

/** Loads the student's evidence for every enrollment and evaluates each unit (no writes). */
export async function evaluateStudent(tx: Tx, orgId: string, studentId: string): Promise<StudentEvaluation> {
  const enrollments = (
    await tx.query<EnrollmentRow>(sql`
      SELECT e.id AS enrollment_id, e.program_version_id, e.due_on::text AS due_on, v.policy, v.version_number,
             p.id AS program_id, p.name AS program_name
      FROM app.enrollments e
      JOIN app.program_versions v ON v.org_id = e.org_id AND v.id = e.program_version_id
      JOIN app.programs p ON p.org_id = v.org_id AND p.id = v.program_id
      WHERE e.org_id = ${orgId} AND e.student_id = ${studentId}
      ORDER BY e.created_at, e.id`)
  ).map((e) => ({ ...e, policy: parsePolicy(e.policy) }));
  if (enrollments.length === 0) return { enrollments, units: [], stored: new Map() };

  const versionIds = enrollments.map((e) => e.program_version_id);
  const units = await tx.query<UnitRow>(sql`
    SELECT id, program_version_id, title, position, required, weight, pass_score, required_attendance, requires_review
    FROM app.units WHERE org_id = ${orgId} AND program_version_id = ANY(${versionIds}::uuid[])
    ORDER BY position, id`);
  const unitIds = units.map((u) => u.id);
  const materials = unitIds.length
    ? await tx.query<MaterialEvidenceRow>(sql`
        SELECT m.id, m.unit_id, m.kind, m.required,
               EXISTS (SELECT 1 FROM app.material_receipts r
                       WHERE r.org_id = m.org_id AND r.student_id = ${studentId} AND r.material_id = m.id) AS confirmed,
               qa.attempts, qa.max_score, ql.score AS latest_score,
               sub.state AS submission_state, sub.feedback
        FROM app.materials m
        LEFT JOIN LATERAL (SELECT count(*) AS attempts, max(q.score) AS max_score FROM app.quiz_attempts q
                           WHERE q.org_id = m.org_id AND q.student_id = ${studentId} AND q.material_id = m.id) qa ON m.kind = 'quiz'
        LEFT JOIN LATERAL (SELECT q.score FROM app.quiz_attempts q
                           WHERE q.org_id = m.org_id AND q.student_id = ${studentId} AND q.material_id = m.id
                           ORDER BY q.submitted_at DESC, q.id DESC LIMIT 1) ql ON m.kind = 'quiz'
        LEFT JOIN LATERAL (SELECT s.state, s.feedback FROM app.submissions s
                           WHERE s.org_id = m.org_id AND s.student_id = ${studentId} AND s.material_id = m.id
                           ORDER BY s.submitted_at DESC, s.id DESC LIMIT 1) sub ON m.kind = 'assignment'
        WHERE m.org_id = ${orgId} AND m.unit_id = ANY(${unitIds}::uuid[])`)
    : [];
  const attendance = unitIds.length
    ? await tx.query<{ unit_id: string; satisfied: boolean; records: string }>(sql`
        SELECT s.unit_id, bool_or(a.state IN ('present', 'late')) AS satisfied, count(*) AS records
        FROM app.attendance a
        JOIN app.lesson_slots s ON s.org_id = a.org_id AND s.id = a.slot_id
        WHERE a.org_id = ${orgId} AND a.student_id = ${studentId} AND s.unit_id = ANY(${unitIds}::uuid[])
        GROUP BY s.unit_id`)
    : [];
  const storedRows = await tx.query<StoredUnitRow>(sql`
    SELECT enrollment_id, unit_id, state, completed_at FROM app.unit_progress
    WHERE org_id = ${orgId} AND enrollment_id = ANY(${enrollments.map((e) => e.enrollment_id)}::uuid[])`);
  const stored = new Map(storedRows.map((r) => [`${r.enrollment_id}:${r.unit_id}`, r]));

  const materialsByUnit = new Map<string, MaterialEvidenceRow[]>();
  for (const m of materials) {
    const list = materialsByUnit.get(m.unit_id) ?? [];
    list.push(m);
    materialsByUnit.set(m.unit_id, list);
  }
  const attendanceByUnit = new Map(attendance.map((a) => [a.unit_id, a]));

  const evaluations: UnitEvaluation[] = [];
  for (const e of enrollments) {
    for (const u of units.filter((x) => x.program_version_id === e.program_version_id)) {
      const all = materialsByUnit.get(u.id) ?? [];
      const req = all.filter((m) => m.required);
      const viewable = req.filter((m) => VIEWABLE.has(m.kind));
      const quizzes = req.filter((m) => m.kind === "quiz");
      const assignments = req.filter((m) => m.kind === "assignment");
      const passScore = effectivePassScore(numOrNull(u.pass_score));

      const quizScores = quizzes.map((q) => effectiveQuizScore(e.policy, numOrNull(q.max_score), numOrNull(q.latest_score)));
      const quizOk = quizScores.every((s) => s !== null && s >= passScore);
      const attempted = quizScores.filter((s): s is number => s !== null);
      const score = attempted.length ? Math.min(...attempted) : null;

      const assignmentOk = assignments.every((a) => a.submission_state === "accepted" || (!u.requires_review && a.submission_state === "submitted"));
      const awaitingReview = u.requires_review && assignments.some((a) => a.submission_state === "submitted");
      const assignmentsDoneOrAwaiting = assignments.every((a) => a.submission_state === "accepted" || a.submission_state === "submitted");
      const att = attendanceByUnit.get(u.id);
      const attendanceSatisfied = !!att?.satisfied;
      const attendanceOk = !u.required_attendance || attendanceSatisfied;
      const confirmed = viewable.filter((m) => m.confirmed).length;
      const confirmedOk = confirmed === viewable.length;

      const hasCondition = req.length > 0 || u.required_attendance;
      const verifiable = quizzes.length > 0 || assignments.length > 0 || u.required_attendance;
      const selfReportOnly = req.some((m) => m.kind === "video") && !verifiable;
      const reviewImpossible = u.requires_review && assignments.length === 0;
      const completable = hasCondition && !selfReportOnly && !reviewImpossible;

      const activity =
        all.some((m) => m.confirmed || num(m.attempts) > 0 || m.submission_state !== null) || num(att?.records) > 0;

      let state: UnitState;
      if (completable && confirmedOk && quizOk && assignmentOk && attendanceOk) state = "completed";
      else if (completable && awaitingReview && confirmedOk && quizOk && attendanceOk && assignmentsDoneOrAwaiting) state = "review_pending";
      else if (activity) state = "in_progress";
      else state = "not_started";

      const feedback = assignments.map((a) => a.feedback).find((f) => f !== null && f !== "") ?? null;
      evaluations.push({
        enrollmentId: e.enrollment_id,
        programVersionId: e.program_version_id,
        programName: e.program_name,
        unitId: u.id,
        title: u.title,
        position: u.position,
        required: u.required,
        weight: num(u.weight),
        requiresReview: u.requires_review,
        requiredAttendance: u.required_attendance,
        passScore,
        materialsTotal: viewable.length,
        materialsConfirmed: confirmed,
        quizPassed: quizzes.length ? quizOk : null,
        score,
        submissionState: aggregateSubmission(assignments.map((a) => a.submission_state)),
        feedback,
        attendanceSatisfied,
        state,
      });
    }
  }
  return { enrollments, units: evaluations, stored };
}

/**
 * Recomputes unit_progress for every enrollment of the student from the underlying evidence.
 * Call it in the same transaction after any change to receipts, quiz attempts, submission reviews or attendance.
 * Serialised per student with an advisory lock; each state change is written to the audit log (WEB-12 history).
 */
export async function recomputeStudentProgress(tx: Tx, orgId: string, studentId: string): Promise<void> {
  await lockKey(tx, `progress:${orgId}:${studentId}`);
  const evaluation = await evaluateStudent(tx, orgId, studentId);
  for (const u of evaluation.units) {
    const key = `${u.enrollmentId}:${u.unitId}`;
    const current = evaluation.stored.get(key);
    if (!current) {
      await tx.exec(sql`
        INSERT INTO app.unit_progress(org_id, enrollment_id, program_version_id, unit_id, state, completed_at)
        VALUES (${orgId}, ${u.enrollmentId}, ${u.programVersionId}, ${u.unitId}, ${u.state},
                ${u.state === "completed" ? sql`clock_timestamp()` : sql`NULL`})
        ON CONFLICT (org_id, enrollment_id, unit_id) DO NOTHING`);
      if (u.state !== "not_started") await auditUnitChange(tx, orgId, studentId, unitChangePayload(u, "not_started"));
      continue;
    }
    if (current.state === u.state) continue;
    await tx.exec(sql`
      UPDATE app.unit_progress
      SET state = ${u.state},
          completed_at = ${u.state === "completed" ? sql`coalesce(completed_at, clock_timestamp())` : sql`NULL`},
          row_version = row_version + 1, updated_at = clock_timestamp()
      WHERE org_id = ${orgId} AND enrollment_id = ${u.enrollmentId} AND unit_id = ${u.unitId}`);
    await auditUnitChange(tx, orgId, studentId, unitChangePayload(u, current.state));
  }
}

/** History entry attributed to the user whose action caused the change (app.user_id of the transaction). */
async function auditUnitChange(tx: Tx, orgId: string, studentId: string, payload: Record<string, unknown>): Promise<void> {
  await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
    VALUES (${orgId}, app.actor_id(), 'progress.unit_state_changed', ${studentId}, ${json(payload)}::jsonb)`);
}

function unitChangePayload(u: UnitEvaluation, before: UnitState): Record<string, unknown> {
  return {
    enrollment_id: u.enrollmentId,
    unit_id: u.unitId,
    unit_title: u.title,
    program_name: u.programName,
    before,
    after: u.state,
    score: u.score,
    materials_confirmed: u.materialsConfirmed,
    materials_total: u.materialsTotal,
    submission_state: u.submissionState,
  };
}

export interface ProgressDto {
  student_id: string;
  student_name: string;
  progress_percent: number | null;
  required_total: number;
  required_completed: number;
  units: Record<string, unknown>[];
  enrollments: Record<string, unknown>[];
}

/**
 * The Progress DTO (GET /students/{id}/progress, dashboards, voice). Unit states come from unit_progress (kept
 * current by recomputeStudentProgress); details (score, feedback, confirmations) come from the evidence.
 * `today` is the organisation-timezone date (YYYY-MM-DD) used for the derived overdue flag.
 */
export async function readStudentProgress(tx: Tx, orgId: string, studentId: string, today: string): Promise<ProgressDto | null> {
  const student = await tx.maybeOne<{ display_name: string }>(sql`
    SELECT u.display_name FROM app.student_profiles sp JOIN app.users u ON u.id = sp.id
    WHERE sp.org_id = ${orgId} AND sp.id = ${studentId}`);
  if (!student) return null;
  const ev = await evaluateStudent(tx, orgId, studentId);
  let totalCents = 0;
  let completedCents = 0;
  let requiredTotal = 0;
  let requiredCompleted = 0;
  const units = ev.units.map((u) => {
    const stored = ev.stored.get(`${u.enrollmentId}:${u.unitId}`);
    const state = stored?.state ?? u.state;
    if (u.required) {
      requiredTotal++;
      totalCents += toCents(u.weight);
      if (state === "completed") {
        requiredCompleted++;
        completedCents += toCents(u.weight);
      }
    }
    return {
      id: u.unitId,
      title: u.title,
      state,
      weight: u.weight,
      score: u.score,
      requires_review: u.requiresReview,
      feedback: u.feedback,
      enrollment_id: u.enrollmentId,
      program_version_id: u.programVersionId,
      program_name: u.programName,
      position: u.position,
      required: u.required,
      completed_at: isoOrNull(stored?.completed_at ?? null),
      materials_total: u.materialsTotal,
      materials_confirmed: u.materialsConfirmed,
      quiz_passed: u.quizPassed,
      submission_state: u.submissionState,
      attendance_required: u.requiredAttendance,
      attendance_satisfied: u.attendanceSatisfied,
    };
  });
  const enrollments = ev.enrollments.map((e) => {
    const mine = units.filter((u) => u.enrollment_id === e.enrollment_id && u.required);
    const total = mine.reduce((s, u) => s + toCents(u.weight), 0);
    const done = mine.filter((u) => u.state === "completed");
    const completed = mine.length > 0 && done.length === mine.length;
    return {
      enrollment_id: e.enrollment_id,
      program_id: e.program_id,
      program_name: e.program_name,
      program_version_id: e.program_version_id,
      version_number: e.version_number,
      due_on: e.due_on,
      overdue: !completed && e.due_on < today,
      progress_percent: progressPercent(
        done.reduce((s, u) => s + toCents(u.weight), 0),
        total,
      ),
      required_total: mine.length,
      required_completed: done.length,
    };
  });
  return {
    student_id: studentId,
    student_name: student.display_name,
    progress_percent: progressPercent(completedCents, totalCents),
    required_total: requiredTotal,
    required_completed: requiredCompleted,
    units,
    enrollments,
  };
}

/**
 * `LEFT JOIN LATERAL (...) <as> ON TRUE` exposing `<as>.pct`: the student's current overall progress percent with the
 * same formula as readStudentProgress (SQL round = half away from zero, identical to Math.round for positives).
 */
export function studentProgressJoin(studentIdColumn: string, as = "prog"): SqlFragment {
  return sql`LEFT JOIN LATERAL (
    SELECT CASE WHEN coalesce(sum(u.weight), 0) = 0 THEN NULL
                ELSE round(100.0 * coalesce(sum(u.weight) FILTER (WHERE up.state = 'completed'), 0) / sum(u.weight))::int END AS pct
    FROM app.enrollments e
    JOIN app.units u ON u.org_id = e.org_id AND u.program_version_id = e.program_version_id AND u.required
    LEFT JOIN app.unit_progress up ON up.org_id = e.org_id AND up.enrollment_id = e.id AND up.unit_id = u.id
    WHERE e.org_id = app.org_id() AND e.student_id = ${ident(studentIdColumn)}
  ) ${ident(as)} ON TRUE`;
}
