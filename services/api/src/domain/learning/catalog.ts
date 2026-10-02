/** Read models (DTO queries) for programs, versions, units and materials. Counts are always DB aggregates. */
import type { Tx } from "../../db/client";
import { sql, type SqlFragment } from "../../db/sql";
import { fail } from "../../http/errors";
import { parsePolicy } from "../progress";
import { iso, isoOrNull, num, numOrNull } from "./common";

// ---- programs ---------------------------------------------------------------------------------

export const PROGRAM_SELECT = sql`
  SELECT p.id, p.name, p.description, p.department_name, p.archived, p.row_version, p.created_at,
         pub.id AS published_version_id, lv.id AS latest_id, lv.version_number AS latest_number, lv.state AS latest_state,
         dv.id AS draft_version_id,
         (SELECT count(*) FROM app.units u WHERE u.org_id = p.org_id AND u.program_version_id = coalesce(pub.id, lv.id)) AS unit_count,
         (SELECT count(*) FROM app.materials m JOIN app.units u ON u.org_id = m.org_id AND u.id = m.unit_id
           WHERE m.org_id = p.org_id AND u.program_version_id = coalesce(pub.id, lv.id)) AS material_count,
         (SELECT count(DISTINCT e.student_id) FROM app.enrollments e
           JOIN app.program_versions ev ON ev.org_id = e.org_id AND ev.id = e.program_version_id
           JOIN app.student_profiles sp ON sp.org_id = e.org_id AND sp.id = e.student_id
           WHERE e.org_id = p.org_id AND ev.program_id = p.id AND sp.active) AS student_count
  FROM app.programs p
  LEFT JOIN app.program_versions pub ON pub.org_id = p.org_id AND pub.program_id = p.id AND pub.state = 'published'
  LEFT JOIN LATERAL (SELECT v.id, v.version_number, v.state FROM app.program_versions v
                     WHERE v.org_id = p.org_id AND v.program_id = p.id ORDER BY v.version_number DESC LIMIT 1) lv ON TRUE
  LEFT JOIN app.program_versions dv ON dv.org_id = p.org_id AND dv.program_id = p.id AND dv.state = 'draft'`;

export interface ProgramRow {
  id: string;
  name: string;
  description: string;
  department_name: string;
  archived: boolean;
  row_version: number;
  created_at: Date;
  published_version_id: string | null;
  latest_id: string | null;
  latest_number: number | null;
  latest_state: string | null;
  draft_version_id: string | null;
  unit_count: string;
  material_count: string;
  student_count: string;
}

export function programDto(r: ProgramRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    department_name: r.department_name,
    archived: r.archived,
    published_version_id: r.published_version_id,
    unit_count: num(r.unit_count),
    material_count: num(r.material_count),
    student_count: num(r.student_count),
    row_version: r.row_version,
    latest_version: r.latest_id ? { id: r.latest_id, version_number: r.latest_number as number, state: r.latest_state as string } : null,
    draft_version_id: r.draft_version_id,
    created_at: iso(r.created_at),
  };
}

export async function loadProgram(tx: Tx, orgId: string, id: string) {
  const row = await tx.maybeOne<ProgramRow>(sql`${PROGRAM_SELECT} WHERE p.org_id = ${orgId} AND p.id = ${id}`);
  if (!row) fail("NOT_FOUND");
  return programDto(row);
}

// ---- versions ---------------------------------------------------------------------------------

export const VERSION_SELECT = sql`
  SELECT v.id, v.program_id, v.version_number, v.state, v.row_version, v.policy, v.published_at, v.created_at, v.source_version_id,
         (SELECT count(*) FROM app.units u WHERE u.org_id = v.org_id AND u.program_version_id = v.id) AS unit_count,
         (SELECT count(*) FROM app.materials m JOIN app.units u ON u.org_id = m.org_id AND u.id = m.unit_id
           WHERE m.org_id = v.org_id AND u.program_version_id = v.id) AS material_count,
         (SELECT coalesce(sum(u.weight), 0) FROM app.units u WHERE u.org_id = v.org_id AND u.program_version_id = v.id AND u.required) AS required_weight_total
  FROM app.program_versions v`;

export interface VersionRow {
  id: string;
  program_id: string;
  version_number: number;
  state: "draft" | "published" | "archived";
  row_version: number;
  policy: unknown;
  published_at: Date | null;
  created_at: Date;
  source_version_id: string | null;
  unit_count: string;
  material_count: string;
  required_weight_total: string;
}

export function versionDto(r: VersionRow) {
  return {
    id: r.id,
    program_id: r.program_id,
    version_number: r.version_number,
    state: r.state,
    row_version: r.row_version,
    policy: parsePolicy(r.policy),
    published_at: isoOrNull(r.published_at),
    created_at: iso(r.created_at),
    source_version_id: r.source_version_id,
    unit_count: num(r.unit_count),
    material_count: num(r.material_count),
    required_weight_total: num(r.required_weight_total),
  };
}

export async function loadVersion(tx: Tx, orgId: string, id: string) {
  const row = await tx.maybeOne<VersionRow>(sql`${VERSION_SELECT} WHERE v.org_id = ${orgId} AND v.id = ${id}`);
  if (!row) fail("NOT_FOUND");
  return versionDto(row);
}

// ---- units ------------------------------------------------------------------------------------

export const UNIT_SELECT = sql`
  SELECT u.id, u.program_version_id, u.title, u.position, u.required, u.weight, u.pass_score, u.required_attendance,
         u.requires_review, u.row_version,
         (SELECT count(*) FROM app.materials m WHERE m.org_id = u.org_id AND m.unit_id = u.id) AS material_count
  FROM app.units u`;

export interface UnitRow {
  id: string;
  program_version_id: string;
  title: string;
  position: number;
  required: boolean;
  weight: string;
  pass_score: string | null;
  required_attendance: boolean;
  requires_review: boolean;
  row_version: number;
  material_count: string;
}

export function unitDto(r: UnitRow) {
  return {
    id: r.id,
    program_version_id: r.program_version_id,
    title: r.title,
    position: r.position,
    required: r.required,
    weight: num(r.weight),
    pass_score: numOrNull(r.pass_score),
    required_attendance: r.required_attendance,
    requires_review: r.requires_review,
    row_version: r.row_version,
    material_count: num(r.material_count),
  };
}

export async function loadUnit(tx: Tx, orgId: string, id: string) {
  const row = await tx.maybeOne<UnitRow>(sql`${UNIT_SELECT} WHERE u.org_id = ${orgId} AND u.id = ${id}`);
  if (!row) fail("NOT_FOUND");
  return unitDto(row);
}

// ---- materials --------------------------------------------------------------------------------

/** Material + its unit/version/program context. `learner` adds the student's own status columns. */
export function materialSelect(learnerId: string | null): SqlFragment {
  return sql`
    SELECT m.id, m.unit_id, m.title, m.description, m.kind, m.required, m.scan_state, m.published, m.size_bytes, m.row_version,
           m.external_url, m.upload_id, m.object_key, m.created_at,
           up.filename, coalesce(up.detected_type, up.content_type) AS content_type, up.size_bytes AS upload_size,
           u.program_version_id, u.pass_score, u.requires_review, v.state AS version_state, v.policy, v.program_id,
           CASE WHEN m.kind = 'quiz' THEN (SELECT count(*) FROM app.quiz_questions q WHERE q.org_id = m.org_id AND q.material_id = m.id) END AS question_count
           ${
             learnerId
               ? sql`,
           (SELECT r.confirmed_at FROM app.material_receipts r WHERE r.org_id = m.org_id AND r.material_id = m.id AND r.student_id = ${learnerId}) AS my_confirmed_at,
           (SELECT count(*) FROM app.quiz_attempts q WHERE q.org_id = m.org_id AND q.material_id = m.id AND q.student_id = ${learnerId}) AS my_attempts,
           (SELECT max(q.score) FROM app.quiz_attempts q WHERE q.org_id = m.org_id AND q.material_id = m.id AND q.student_id = ${learnerId}) AS my_max_score,
           (SELECT q.score FROM app.quiz_attempts q WHERE q.org_id = m.org_id AND q.material_id = m.id AND q.student_id = ${learnerId}
             ORDER BY q.submitted_at DESC, q.id DESC LIMIT 1) AS my_latest_score,
           (SELECT s.state FROM app.submissions s WHERE s.org_id = m.org_id AND s.material_id = m.id AND s.student_id = ${learnerId}
             ORDER BY s.submitted_at DESC, s.id DESC LIMIT 1) AS my_submission_state,
           (SELECT s.feedback FROM app.submissions s WHERE s.org_id = m.org_id AND s.material_id = m.id AND s.student_id = ${learnerId}
             ORDER BY s.submitted_at DESC, s.id DESC LIMIT 1) AS my_feedback`
               : sql``
           }
    FROM app.materials m
    JOIN app.units u ON u.org_id = m.org_id AND u.id = m.unit_id
    JOIN app.program_versions v ON v.org_id = u.org_id AND v.id = u.program_version_id
    LEFT JOIN app.upload_jobs up ON up.org_id = m.org_id AND up.id = m.upload_id`;
}

export interface MaterialRow {
  id: string;
  unit_id: string;
  title: string;
  description: string;
  kind: "pdf" | "video" | "image" | "link" | "quiz" | "assignment";
  required: boolean;
  scan_state: "pending" | "clean" | "blocked" | "not_applicable";
  published: boolean;
  size_bytes: string | null;
  row_version: number;
  external_url: string | null;
  upload_id: string | null;
  object_key: string | null;
  created_at: Date;
  filename: string | null;
  content_type: string | null;
  upload_size: string | null;
  program_version_id: string;
  pass_score: string | null;
  requires_review: boolean;
  version_state: "draft" | "published" | "archived";
  policy: unknown;
  program_id: string;
  question_count: string | null;
  my_confirmed_at?: Date | null;
  my_attempts?: string;
  my_max_score?: string | null;
  my_latest_score?: string | null;
  my_submission_state?: string | null;
  my_feedback?: string | null;
}

export function materialDto(r: MaterialRow, opts: { learner?: boolean } = {}) {
  const dto: Record<string, unknown> = {
    id: r.id,
    unit_id: r.unit_id,
    program_version_id: r.program_version_id,
    title: r.title,
    description: r.description,
    kind: r.kind,
    required: r.required,
    scan_state: r.scan_state,
    published: r.published,
    size_bytes: numOrNull(r.size_bytes ?? r.upload_size),
    row_version: r.row_version,
    external_url: r.kind === "link" ? r.external_url : null,
    upload_id: r.upload_id,
    filename: r.filename,
    content_type: r.content_type,
    question_count: r.kind === "quiz" ? num(r.question_count) : null,
  };
  if (opts.learner) {
    const policy = parsePolicy(r.policy);
    const highest = numOrNull(r.my_max_score);
    const latest = numOrNull(r.my_latest_score);
    const score = r.kind === "quiz" ? (policy.quiz_score_policy === "latest" ? latest : highest) : null;
    const passScore = r.pass_score === null ? 100 : num(r.pass_score);
    dto.learner_status = {
      confirmed_at: isoOrNull(r.my_confirmed_at ?? null),
      quiz_attempts_used: r.kind === "quiz" ? num(r.my_attempts) : null,
      quiz_score: score,
      quiz_passed: r.kind === "quiz" ? score !== null && score >= passScore : null,
      submission_state: r.kind === "assignment" ? (r.my_submission_state ?? null) : null,
      feedback: r.kind === "assignment" ? (r.my_feedback ?? null) : null,
    };
  }
  return dto;
}

export async function loadMaterialRow(tx: Tx, orgId: string, id: string, learnerId: string | null = null): Promise<MaterialRow> {
  const row = await tx.maybeOne<MaterialRow>(sql`${materialSelect(learnerId)} WHERE m.org_id = ${orgId} AND m.id = ${id}`);
  if (!row) fail("NOT_FOUND");
  return row;
}

/** Whether the student is enrolled in the program version (students only ever see enrolled, published content). */
export async function isEnrolled(tx: Tx, orgId: string, studentId: string, versionId: string): Promise<boolean> {
  const row = await tx.maybeOne(sql`SELECT 1 FROM app.enrollments WHERE org_id = ${orgId} AND student_id = ${studentId} AND program_version_id = ${versionId}`);
  return row !== null;
}

/**
 * Students may access a material only when enrolled in its (published or archived) version, the material is
 * published and its file was scanned clean. Anything else is indistinguishable from a missing resource (404).
 */
export async function assertStudentMaterialAccess(tx: Tx, orgId: string, studentId: string, m: MaterialRow): Promise<void> {
  if (m.version_state === "draft" || !m.published || m.scan_state === "blocked" || m.scan_state === "pending") fail("NOT_FOUND");
  if (!(await isEnrolled(tx, orgId, studentId, m.program_version_id))) fail("NOT_FOUND");
}
