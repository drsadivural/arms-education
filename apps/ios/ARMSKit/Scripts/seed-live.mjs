// Seeds an isolated organisation in the LOCAL stack for the ARMSKit live contract test
// (Tests/ARMSKitTests/LiveAPITests.swift). Never point this at staging/production.
//
//   node apps/ios/ARMSKit/Scripts/seed-live.mjs <fixture.json>
//
// Creates, with a unique stamp: a teacher and a student in Supabase Auth (GoTrue admin API, password sign-in),
// their ARMS profiles, a classroom, a published program version (1 unit: link + quiz + assignment) with the
// student's enrollment, three lesson slots (two bookable in the next days, one starting in 10 minutes for
// attendance), two unread notifications and an open voice session row for the student (the local stack has no
// OpenAI key, so /voice/tool-calls is driven with this session). Writes the ids/credentials to <fixture.json>.
//
// Env (defaults from services/api/.dev.vars): DATABASE_ADMIN_URL, AUTH_URL, AUTH_ADMIN_SECRET.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const devVars = (() => {
  try {
    return Object.fromEntries(
      readFileSync(join(root, "services/api/.dev.vars"), "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
})();
const AUTH = process.env.AUTH_URL ?? devVars.SUPABASE_AUTH_URL ?? "http://localhost:9999";
const ADMIN_SECRET = process.env.AUTH_ADMIN_SECRET ?? devVars.SUPABASE_ADMIN_SECRET ?? "";
const DB = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:arms_dev_pw@127.0.0.1:55433/arms";
const out = process.argv[2];
if (!out) {
  console.error("usage: node seed-live.mjs <fixture.json>");
  process.exit(2);
}
if (!/^(postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)[:/])/.test(DB) || !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(AUTH)) {
  console.error("refusing to seed a non-local stack");
  process.exit(2);
}

const stamp = Date.now().toString(36);
const password = `Ios-${stamp}-Pass1`;

async function authUser(email) {
  const res = await fetch(`${AUTH}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}`, apikey: ADMIN_SECRET },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok || !body.id) throw new Error(`GoTrue admin/users failed: ${res.status}`);
  return body.id;
}

const teacherEmail = `ios-teacher-${stamp}@arms.local`;
const studentEmail = `ios-student-${stamp}@arms.local`;
const teacherId = await authUser(teacherEmail);
const studentId = await authUser(studentEmail);

const db = new pg.Client({ connectionString: DB });
await db.connect();
const q = async (text, params) => (await db.query(text, params)).rows;
try {
  await db.query("BEGIN");
  const [{ id: orgId }] = await q("INSERT INTO app.organizations(name) VALUES ($1) RETURNING id", [`iOS契約テスト ${stamp}`]);
  await q("INSERT INTO app.users(id, display_name, email) VALUES ($1, '田中 祥司', $2), ($3, '和田 一夫', $4)", [teacherId, teacherEmail, studentId, studentEmail]);
  await q("INSERT INTO app.memberships(org_id, id, role) VALUES ($1, $2, 'teacher'), ($1, $3, 'student')", [orgId, teacherId, studentId]);
  await q("INSERT INTO app.teacher_profiles(org_id, id, teacher_number, kana, department_name) VALUES ($1, $2, $3, 'たなか しょうじ', '開発部')", [orgId, teacherId, `T-${stamp}`]);
  const [{ id: classroomId }] = await q(
    "INSERT INTO app.classrooms(org_id, name, capacity, starts_on, ends_on) VALUES ($1, $2, 30, current_date - 30, current_date + 120) RETURNING id",
    [orgId, `新入社員Aクラス ${stamp}`],
  );
  await q("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, true)", [orgId, classroomId, teacherId]);
  await q(
    `INSERT INTO app.student_profiles(org_id, id, employee_number, kana, company_name, department_name, joined_on, classroom_id, teacher_id, training_starts_on, training_due_on)
     VALUES ($1, $2, $3, 'わだ かずお', 'H&A', '開発部', current_date - 30, $4, $5, current_date - 30, current_date + 90)`,
    [orgId, studentId, `E-${stamp}`, classroomId, teacherId],
  );

  // Published program version: one unit with a link, a quiz (1 question, answer "b") and an assignment.
  const [{ id: programId }] = await q("INSERT INTO app.programs(org_id, name) VALUES ($1, '新入社員基礎研修') RETURNING id", [orgId]);
  const [{ id: versionId }] = await q(
    `INSERT INTO app.program_versions(org_id, program_id, version_number, state, policy) VALUES ($1, $2, 1, 'draft', '{"max_quiz_attempts":3,"quiz_score_policy":"highest"}') RETURNING id`,
    [orgId, programId],
  );
  const [{ id: unitId }] = await q(
    "INSERT INTO app.units(org_id, program_version_id, title, position, required, weight, pass_score, requires_review) VALUES ($1, $2, 'IT基礎・セキュリティ', 0, true, 1, 80, true) RETURNING id",
    [orgId, versionId],
  );
  const material = async (title, kind, extra = {}) =>
    (
      await q(
        `INSERT INTO app.materials(org_id, unit_id, title, kind, external_url, scan_state, published, required, description)
         VALUES ($1, $2, $3, $4, $5, 'not_applicable', true, true, $6) RETURNING id`,
        [orgId, unitId, title, kind, extra.url ?? null, extra.description ?? ""],
      )
    )[0].id;
  const linkId = await material("社内ポータルの使い方", "link", { url: "https://portal.example.invalid/guide" });
  const quizId = await material("確認テスト", "quiz", { description: "全1問・80点以上で合格" });
  const assignmentId = await material("業務改善レポート", "assignment", { description: "改善案をPDFで提出してください。" });
  await q(
    `INSERT INTO app.quiz_questions(org_id, material_id, prompt, choices, answer_key, points, position)
     VALUES ($1, $2, '不審なメールを受信した場合は？', '[{"id":"a","label":"添付ファイルをすぐに開く"},{"id":"b","label":"担当部署に確認して報告する"}]', '["b"]', 1, 0)`,
    [orgId, quizId],
  );
  await q("UPDATE app.program_versions SET state = 'published', published_at = now() WHERE org_id = $1 AND id = $2", [orgId, versionId]);
  await q("INSERT INTO app.classroom_programs(org_id, classroom_id, program_version_id) VALUES ($1, $2, $3)", [orgId, classroomId, versionId]);
  await q("INSERT INTO app.enrollments(org_id, student_id, program_version_id, due_on) VALUES ($1, $2, $3, current_date + 60)", [orgId, studentId, versionId]);

  // Lesson slots: A (REST booking, +3 days), B (voice booking, +4 days), C (today, starts in 10 minutes → attendance open).
  const slot = async (title, startsSql, minutes, closesSql) =>
    (
      await q(
        `INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, title, starts_at, ends_at, capacity, booking_closes_at, state, meeting_url)
         VALUES ($1, $2, $3, $4, ${startsSql}, ${startsSql} + make_interval(mins => ${minutes}), 10, ${closesSql}, 'open', 'https://meet.example.invalid/arms') RETURNING id`,
        [orgId, classroomId, teacherId, title],
      )
    )[0].id;
  const slotA = await slot("ビジネスマナー", "date_trunc('hour', now()) + interval '3 days'", 90, "date_trunc('hour', now()) + interval '2 days'");
  const slotB = await slot("IT基礎・セキュリティ", "date_trunc('hour', now()) + interval '4 days'", 90, "date_trunc('hour', now()) + interval '3 days'");
  const slotC = await slot("本日の振り返り", "date_trunc('minute', now()) + interval '10 minutes'", 30, "date_trunc('minute', now()) + interval '10 minutes'");

  // Two unread in-app notifications using the server's deep-link forms.
  await q(
    `INSERT INTO app.notifications(org_id, user_id, event_id, title, body, deep_link) VALUES
       ($1, $2, $3, '本日の授業があります', '本日の授業を確認してください。', 'arms://lessons/today'),
       ($1, $2, $4, '授業枠のお知らせ', '新しい授業枠が公開されました。', $5)`,
    [orgId, studentId, randomUUID(), randomUUID(), `arms://lesson-slots/${slotB}`],
  );

  // Open voice session for the student (what POST /voice/sessions would have created).
  const [{ id: voiceSessionId }] = await q(
    "INSERT INTO app.voice_sessions(org_id, user_id, role, model, expires_at, reserved_seconds) VALUES ($1, $2, 'student', 'gpt-realtime-2.1', now() + interval '10 minutes', 600) RETURNING id",
    [orgId, studentId],
  );
  await db.query("COMMIT");

  writeFileSync(
    out,
    JSON.stringify(
      {
        stamp,
        orgId,
        password,
        teacher: { id: teacherId, email: teacherEmail },
        student: { id: studentId, email: studentEmail },
        classroomId,
        programId,
        programVersionId: versionId,
        unitId,
        materials: { link: linkId, quiz: quizId, assignment: assignmentId },
        slots: { a: slotA, b: slotB, c: slotC },
        voiceSessionId,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.info(`seeded organisation ${orgId} → ${out}`);
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}
