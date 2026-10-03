// Demo data for trying ARMS (Web + iOS) in an organisation: a demo teacher and a demo student with a known password,
// a 【デモ】 classroom, a published 【デモ】 program (link + quiz + assignment) with the student's enrollment, three
// lesson slots in the coming days and a welcome notification. Optionally sets the administrator's password too.
// Everything is labelled 【デモ】 / DEMO- so it can be told apart and stopped later (ユーザー管理 → 停止).
//
//   DATABASE_ADMIN_URL=postgres://<owner>@<host>/<db> node scripts/admin/seed-demo.mjs \
//     --org "H&A研修センター" --teacher sadi+teacher@ayonix.com --student sadi+student@ayonix.com \
//     --password '<password>' [--admin sadi@ayonix.com]
//
// Re-running is safe: existing demo accounts/classroom/program are reused, only their passwords are reset.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { setPassword } from "../auth/credentials.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith("--") ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const url = process.env.DATABASE_ADMIN_URL;
if (!url || !args.org || !args.teacher || !args.student || !args.password) {
  console.error("usage: DATABASE_ADMIN_URL=… node scripts/admin/seed-demo.mjs --org <name> --teacher <email> --student <email> --password <pw> [--admin <email>]");
  process.exit(2);
}

const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async (text, params) => (await db.query(text, params)).rows;
const one = async (text, params) => (await q(text, params))[0];

async function person(orgId, email, name, role) {
  const existing = await one("SELECT id FROM app.users WHERE lower(email) = lower($1)", [email]);
  const id = existing?.id ?? randomUUID();
  if (!existing) await q("INSERT INTO app.users(id, display_name, email) VALUES ($1, $2, $3)", [id, name, email]);
  await q(
    `INSERT INTO app.memberships(org_id, id, role, active) VALUES ($1, $2, $3, true)
     ON CONFLICT (org_id, id) DO UPDATE SET active = true`,
    [orgId, id, role],
  );
  await setPassword(db, id, args.password);
  return id;
}

try {
  await db.query("BEGIN");
  const org = await one("SELECT id FROM app.organizations WHERE name = $1", [args.org]);
  if (!org) throw new Error(`organisation not found: ${args.org}`);
  const orgId = org.id;
  await db.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

  if (args.admin) {
    const admin = await one(
      "SELECT u.id FROM app.users u JOIN app.memberships m ON m.id = u.id AND m.org_id = $1 AND m.role = 'admin' WHERE lower(u.email) = lower($2)",
      [orgId, args.admin],
    );
    if (!admin) throw new Error(`administrator not found in ${args.org}: ${args.admin}`);
    await setPassword(db, admin.id, args.password);
  }

  const teacherId = await person(orgId, args.teacher, "デモ 講師", "teacher");
  await q(
    `INSERT INTO app.teacher_profiles(org_id, id, teacher_number, kana, department_name, specialties)
     VALUES ($1, $2, 'DEMO-T1', 'でも こうし', '人事部', '["ビジネスマナー","IT基礎"]') ON CONFLICT DO NOTHING`,
    [orgId, teacherId],
  );

  let classroom = await one("SELECT id FROM app.classrooms WHERE org_id = $1 AND name = '【デモ】2026年度 新入社員クラス'", [orgId]);
  if (!classroom) {
    classroom = await one(
      "INSERT INTO app.classrooms(org_id, name, capacity, starts_on, ends_on) VALUES ($1, '【デモ】2026年度 新入社員クラス', 30, current_date - 7, current_date + 180) RETURNING id",
      [orgId],
    );
    await q("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, true)", [orgId, classroom.id, teacherId]);
  }

  const studentId = await person(orgId, args.student, "デモ 受講者", "student");
  await q(
    `INSERT INTO app.student_profiles(org_id, id, employee_number, kana, company_name, department_name, joined_on, classroom_id, teacher_id, training_starts_on, training_due_on)
     VALUES ($1, $2, 'DEMO-S1', 'でも じゅこうしゃ', 'H&A', '開発部', current_date - 7, $3, $4, current_date - 7, current_date + 180)
     ON CONFLICT DO NOTHING`,
    [orgId, studentId, classroom.id, teacherId],
  );

  let program = await one("SELECT id FROM app.programs WHERE org_id = $1 AND name = '【デモ】新入社員基礎研修'", [orgId]);
  if (!program) {
    program = await one("INSERT INTO app.programs(org_id, name, description) VALUES ($1, '【デモ】新入社員基礎研修', 'デモ用の教育プログラムです。') RETURNING id", [orgId]);
    const version = await one(
      `INSERT INTO app.program_versions(org_id, program_id, version_number, state, policy)
       VALUES ($1, $2, 1, 'draft', '{"max_quiz_attempts":3,"quiz_score_policy":"highest"}') RETURNING id`,
      [orgId, program.id],
    );
    const unit = await one(
      "INSERT INTO app.units(org_id, program_version_id, title, position, required, weight, pass_score, requires_review) VALUES ($1, $2, '情報セキュリティの基本', 0, true, 1, 80, true) RETURNING id",
      [orgId, version.id],
    );
    const material = async (title, kind, extra = {}) =>
      (
        await one(
          `INSERT INTO app.materials(org_id, unit_id, title, kind, external_url, scan_state, published, required, description)
           VALUES ($1, $2, $3, $4, $5, 'not_applicable', true, true, $6) RETURNING id`,
          [orgId, unit.id, title, kind, extra.url ?? null, extra.description ?? ""],
        )
      ).id;
    await material("情報セキュリティ対策の基本（IPA）", "link", { url: "https://www.ipa.go.jp/security/", description: "IPAの解説ページを読んでください。" });
    const quizId = await material("確認テスト", "quiz", { description: "全1問・80点以上で合格" });
    await material("業務改善レポート", "assignment", { description: "身近な業務の改善案をPDFで提出してください。" });
    await q(
      `INSERT INTO app.quiz_questions(org_id, material_id, prompt, choices, answer_key, points, position)
       VALUES ($1, $2, '不審なメールを受信した場合は？', '[{"id":"a","label":"添付ファイルをすぐに開く"},{"id":"b","label":"担当部署に確認して報告する"}]', '["b"]', 1, 0)`,
      [orgId, quizId],
    );
    await q("UPDATE app.program_versions SET state = 'published', published_at = now() WHERE org_id = $1 AND id = $2", [orgId, version.id]);
    await q("INSERT INTO app.classroom_programs(org_id, classroom_id, program_version_id) VALUES ($1, $2, $3)", [orgId, classroom.id, version.id]);
    await q("INSERT INTO app.enrollments(org_id, student_id, program_version_id, due_on) VALUES ($1, $2, $3, current_date + 60)", [orgId, studentId, version.id]);

    // Lesson slots in the coming days (10:00 / 14:00 / 10:00 JST), bookable until the day before.
    const slot = (title, days, hour, minutes) =>
      q(
        `INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, title, starts_at, ends_at, capacity, booking_closes_at, state, meeting_url)
         VALUES ($1, $2, $3, $4,
           (date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') + make_interval(days => $5::int, hours => $6::int)) AT TIME ZONE 'Asia/Tokyo',
           (date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') + make_interval(days => $5::int, hours => $6::int, mins => $7::int)) AT TIME ZONE 'Asia/Tokyo',
           10,
           (date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') + make_interval(days => $5::int)) AT TIME ZONE 'Asia/Tokyo',
           'open', NULL)`,
        [orgId, classroom.id, teacherId, title, days, hour, minutes],
      );
    await slot("【デモ】ビジネスマナー", 3, 10, 90);
    await slot("【デモ】情報セキュリティの基本", 4, 14, 90);
    await slot("【デモ】報告・連絡・相談", 7, 10, 60);

    await q(
      `INSERT INTO app.notifications(org_id, user_id, event_id, title, body, deep_link)
       VALUES ($1, $2, $3, 'ARMSへようこそ（デモ）', 'デモ用の授業枠に予約を申請してみましょう。', 'arms://lessons/today')`,
      [orgId, studentId, randomUUID()],
    );
  }

  await q(
    `INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload) VALUES ($1, NULL, 'demo.seeded', $2, '{"via":"scripts/admin/seed-demo.mjs"}'::jsonb)`,
    [orgId, classroom.id],
  );
  await db.query("COMMIT");
  console.info(`demo ready in ${args.org}: teacher ${args.teacher}, student ${args.student}${args.admin ? `, admin ${args.admin} password set` : ""}`);
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}
