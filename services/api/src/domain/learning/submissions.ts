/** Submission read model shared by the student submit endpoint and the teacher review queue. */
import { sql } from "../../db/sql";
import { iso, isoOrNull } from "./common";

export const SUBMISSION_SELECT = sql`
  SELECT s.id, s.material_id, s.student_id, s.state, s.body, s.scan_state, s.feedback, s.row_version, s.submitted_at, s.reviewed_at,
         s.object_key, s.upload_id, su.display_name AS student_name, m.title AS material_title, m.unit_id, un.title AS unit_title,
         up.filename, coalesce(up.detected_type, up.content_type) AS content_type, ru.display_name AS reviewer_name,
         sp.teacher_id, sp.classroom_id
  FROM app.submissions s
  JOIN app.materials m ON m.org_id = s.org_id AND m.id = s.material_id
  JOIN app.units un ON un.org_id = m.org_id AND un.id = m.unit_id
  JOIN app.student_profiles sp ON sp.org_id = s.org_id AND sp.id = s.student_id
  JOIN app.users su ON su.id = s.student_id
  LEFT JOIN app.users ru ON ru.id = s.reviewer_id
  LEFT JOIN app.upload_jobs up ON up.org_id = s.org_id AND up.id = s.upload_id`;

export interface SubmissionRow {
  id: string;
  material_id: string;
  student_id: string;
  state: "submitted" | "accepted" | "revision_requested";
  body: string;
  scan_state: "pending" | "clean" | "blocked" | "not_applicable";
  feedback: string | null;
  row_version: number;
  submitted_at: Date;
  reviewed_at: Date | null;
  object_key: string | null;
  upload_id: string | null;
  student_name: string;
  material_title: string;
  unit_id: string;
  unit_title: string;
  filename: string | null;
  content_type: string | null;
  reviewer_name: string | null;
  teacher_id: string;
  classroom_id: string;
}

export function submissionDto(r: SubmissionRow) {
  return {
    id: r.id,
    material_id: r.material_id,
    student_id: r.student_id,
    state: r.state,
    body: r.body,
    scan_state: r.scan_state,
    feedback: r.feedback,
    row_version: r.row_version,
    submitted_at: iso(r.submitted_at),
    student_name: r.student_name,
    material_title: r.material_title,
    unit_id: r.unit_id,
    unit_title: r.unit_title,
    has_file: r.upload_id !== null,
    filename: r.filename,
    reviewed_at: isoOrNull(r.reviewed_at),
    reviewer_name: r.reviewer_name,
  };
}
