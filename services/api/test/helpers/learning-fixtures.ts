/**
 * Learning fixtures written through the owner pool (bypassing RLS) — used to set up published programs and
 * enrollments quickly. Endpoint behaviour itself is always exercised through the API.
 */
import type pg from "pg";

export interface MaterialSpec {
  kind: "pdf" | "video" | "image" | "link" | "quiz" | "assignment";
  required?: boolean;
  title?: string;
  /** quiz only: questions with correct option ids (choices are a/b/c). */
  questions?: { correct: string[]; points?: number }[];
}

export interface UnitSpec {
  title?: string;
  required?: boolean;
  weight?: number;
  passScore?: number | null;
  requiredAttendance?: boolean;
  requiresReview?: boolean;
  materials?: MaterialSpec[];
}

export interface BuiltProgram {
  programId: string;
  versionId: string;
  units: { id: string; title: string; materials: { id: string; kind: MaterialSpec["kind"]; questionIds: string[] }[] }[];
}

let seq = 0;

/** Program with one version (default: published) built directly in SQL. File materials get a clean upload row. */
export async function buildProgram(
  admin: pg.Pool,
  orgId: string,
  units: UnitSpec[],
  opts: { name?: string; state?: "draft" | "published"; policy?: { max_quiz_attempts: number; quiz_score_policy: "highest" | "latest" }; programId?: string; uploaderId?: string } = {},
): Promise<BuiltProgram> {
  const n = ++seq;
  const programId =
    opts.programId ??
    (await admin.query("INSERT INTO app.programs(org_id, name, description, department_name) VALUES ($1, $2, '説明', '開発部') RETURNING id", [orgId, opts.name ?? `新入社員 基礎研修 ${n}`]))
      .rows[0].id;
  const { rows: vr } = await admin.query(
    `INSERT INTO app.program_versions(org_id, program_id, version_number, state, policy)
     SELECT $1, $2, coalesce(max(version_number), 0) + 1, 'draft', $3::jsonb FROM app.program_versions WHERE org_id = $1 AND program_id = $2 RETURNING id`,
    [orgId, programId, JSON.stringify(opts.policy ?? { max_quiz_attempts: 3, quiz_score_policy: "highest" })],
  );
  const versionId = vr[0].id as string;
  const built: BuiltProgram = { programId, versionId, units: [] };
  for (const [i, u] of units.entries()) {
    const title = u.title ?? `単元${i + 1}`;
    const { rows: ur } = await admin.query(
      `INSERT INTO app.units(org_id, program_version_id, title, position, required, weight, pass_score, required_attendance, requires_review)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [orgId, versionId, title, i, u.required ?? true, u.weight ?? 10, u.passScore === undefined ? 80 : u.passScore, u.requiredAttendance ?? false, u.requiresReview ?? false],
    );
    const unit = { id: ur[0].id as string, title, materials: [] as BuiltProgram["units"][number]["materials"] };
    for (const [j, m] of (u.materials ?? []).entries()) {
      let uploadId: string | null = null;
      let objectKey: string | null = null;
      if (["pdf", "video", "image"].includes(m.kind) && opts.uploaderId) {
        const type = { pdf: "application/pdf", video: "video/mp4", image: "image/png" }[m.kind as "pdf" | "video" | "image"];
        objectKey = `materials/${orgId}/${crypto.randomUUID()}`;
        const { rows: up } = await admin.query(
          `INSERT INTO app.upload_jobs(org_id, user_id, purpose, object_key, quarantine_key, filename, content_type, expected_size, scan_state, state, expires_at, detected_type, size_bytes)
           VALUES ($1, $2, 'material', $3, $4, $5, $6, 100, 'clean', 'clean', now() + interval '1 hour', $6, 100) RETURNING id`,
          [orgId, opts.uploaderId, objectKey, `quarantine/${orgId}/${crypto.randomUUID()}`, `教材${j}.${m.kind === "pdf" ? "pdf" : m.kind === "video" ? "mp4" : "png"}`, type],
        );
        uploadId = up[0].id;
      }
      const scan = ["pdf", "video", "image"].includes(m.kind) ? "clean" : "not_applicable";
      const { rows: mr } = await admin.query(
        `INSERT INTO app.materials(org_id, unit_id, title, kind, object_key, external_url, scan_state, published, required, size_bytes, upload_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, now() + make_interval(secs => $11)) RETURNING id`,
        [orgId, unit.id, m.title ?? `${title}-${m.kind}${j}`, m.kind, objectKey, m.kind === "link" ? "https://example.com/guide" : null, scan, m.required ?? true, uploadId ? 100 : null, uploadId, j],
      );
      const materialId = mr[0].id as string;
      const questionIds: string[] = [];
      if (m.kind === "quiz") {
        for (const [k, q] of (m.questions ?? [{ correct: ["a"] }]).entries()) {
          const { rows: qr } = await admin.query(
            `INSERT INTO app.quiz_questions(org_id, material_id, prompt, choices, answer_key, points, position)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING id`,
            [
              orgId,
              materialId,
              `問題${k + 1}`,
              JSON.stringify([
                { id: "a", label: "選択肢A" },
                { id: "b", label: "選択肢B" },
                { id: "c", label: "選択肢C" },
              ]),
              JSON.stringify(q.correct),
              q.points ?? 10,
              k,
            ],
          );
          questionIds.push(qr[0].id);
        }
      }
      unit.materials.push({ id: materialId, kind: m.kind, questionIds });
    }
    built.units.push(unit);
  }
  if ((opts.state ?? "published") === "published") {
    await admin.query(
      `UPDATE app.materials m SET published = true FROM app.units u WHERE u.org_id = m.org_id AND u.id = m.unit_id AND u.program_version_id = $1`,
      [versionId],
    );
    await admin.query("UPDATE app.program_versions SET state = 'archived' WHERE org_id = $1 AND program_id = $2 AND state = 'published'", [orgId, programId]);
    await admin.query("UPDATE app.program_versions SET state = 'published', published_at = now() WHERE id = $1", [versionId]);
  }
  return built;
}

/** Enrollment + not_started unit_progress rows (what POST /enrollments creates). */
export async function enrollStudent(admin: pg.Pool, orgId: string, studentId: string, versionId: string, dueOn = "2026-12-31"): Promise<string> {
  const { rows } = await admin.query(
    "INSERT INTO app.enrollments(org_id, student_id, program_version_id, due_on) VALUES ($1, $2, $3, $4) RETURNING id",
    [orgId, studentId, versionId, dueOn],
  );
  const id = rows[0].id as string;
  await admin.query(
    `INSERT INTO app.unit_progress(org_id, enrollment_id, program_version_id, unit_id, state)
     SELECT $1, $2, $3, u.id, 'not_started' FROM app.units u WHERE u.org_id = $1 AND u.program_version_id = $3`,
    [orgId, id, versionId],
  );
  return id;
}

export async function linkClassroomProgram(admin: pg.Pool, orgId: string, classroomId: string, versionId: string): Promise<void> {
  await admin.query("INSERT INTO app.classroom_programs(org_id, classroom_id, program_version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [orgId, classroomId, versionId]);
}

export async function unitStates(admin: pg.Pool, enrollmentId: string): Promise<Record<string, string>> {
  const { rows } = await admin.query("SELECT unit_id, state FROM app.unit_progress WHERE enrollment_id = $1", [enrollmentId]);
  return Object.fromEntries(rows.map((r) => [r.unit_id, r.state]));
}

/** Lesson slot linked to a unit + attendance (what the booking module records). */
export async function recordAttendance(
  admin: pg.Pool,
  orgId: string,
  opts: { classroomId: string; teacherId: string; unitId: string; studentId: string; state: "present" | "absent" | "late" | "excused"; startsAt?: string },
): Promise<void> {
  const startsAt = opts.startsAt ?? new Date(Date.UTC(2026, 8, 1 + (++seq % 28), 1 + (seq % 20))).toISOString();
  const endsAt = new Date(new Date(startsAt).getTime() + 30 * 60 * 1000).toISOString();
  const { rows } = await admin.query(
    `INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, unit_id, title, starts_at, ends_at, capacity, booking_closes_at, state)
     VALUES ($1, $2, $3, $4, '研修振り返り面談', $5, $6, 5, $5, 'closed') RETURNING id`,
    [orgId, opts.classroomId, opts.teacherId, opts.unitId, startsAt, endsAt],
  );
  await admin.query("INSERT INTO app.attendance(org_id, slot_id, student_id, state, recorded_by) VALUES ($1, $2, $3, $4, $5)", [
    orgId,
    rows[0].id,
    opts.studentId,
    opts.state,
    opts.teacherId,
  ]);
}
