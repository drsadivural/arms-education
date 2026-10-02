/**
 * Seeds an isolated E2E organisation in the local stack with the DB owner connection: an administrator (password +
 * enrolled TOTP, as if registered at the first sign-in), a teacher (password) and a classroom. Credentials are
 * written in the API's own formats (scripts/auth/credentials.mjs). Writes e2e/.fixture.json (git-ignored).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { newTotpSecret, setPassword, setTotpSecret } from "../../../scripts/auth/credentials.mjs";
import { devVars } from "./accounts";

const DB = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:arms_dev_pw@127.0.0.1:55433/arms";

export default async function globalSetup() {
  const stamp = Date.now().toString(36);
  const password = `E2e-${stamp}-Pass!`;
  const adminEmail = `e2e-admin-${stamp}@arms.local`;
  const teacherEmail = `e2e-teacher-${stamp}@arms.local`;
  const adminId = crypto.randomUUID();
  const teacherId = crypto.randomUUID();
  const totpSecret = newTotpSecret();
  const sessionKey = devVars().WEB_SESSION_ENCRYPTION_KEY;
  if (!sessionKey) throw new Error("WEB_SESSION_ENCRYPTION_KEY missing in services/api/.dev.vars (run infra/local/setup.mjs)");

  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  try {
    await client.query("BEGIN");
    const org = (await client.query("INSERT INTO app.organizations(name) VALUES ($1) RETURNING id", [`E2E組織 ${stamp}`])).rows[0].id as string;
    await client.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, '山田 太郎', $2), ($3, '田中 祥司', $4)", [adminId, adminEmail, teacherId, teacherEmail]);
    await client.query("INSERT INTO app.memberships(org_id, id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'teacher')", [org, adminId, teacherId]);
    await setPassword(client, adminId, password);
    await setPassword(client, teacherId, password);
    await setTotpSecret(client, sessionKey, adminId, totpSecret);
    await client.query("INSERT INTO app.teacher_profiles(org_id, id, teacher_number, kana, department_name, specialties) VALUES ($1, $2, $3, 'たなか しょうじ', '開発部', '[\"IT基礎\"]')", [
      org,
      teacherId,
      `T-${stamp}`,
    ]);
    const classroom = (
      await client.query("INSERT INTO app.classrooms(org_id, name, capacity, starts_on, ends_on) VALUES ($1, $2, 30, '2026-10-01', '2026-12-31') RETURNING id", [org, `2026年度 新入社員Aクラス ${stamp}`])
    ).rows[0].id as string;
    await client.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, true)", [org, classroom, teacherId]);
    await client.query("COMMIT");
    writeFileSync(
      join(import.meta.dirname, ".fixture.json"),
      JSON.stringify({ orgId: org, classroomId: classroom, password, admin: { id: adminId, email: adminEmail, totpSecret }, teacher: { id: teacherId, email: teacherEmail } }, null, 2),
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}
