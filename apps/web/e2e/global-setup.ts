/**
 * Seeds an isolated E2E organisation in the local stack: an administrator (password + enrolled TOTP),
 * a teacher and a classroom with students, created through the real Supabase Auth admin API and the DB owner
 * connection. Writes e2e/.fixture.json (git-ignored) for the tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { totp } from "./totp";

const root = join(import.meta.dirname, "..", "..", "..");
const vars = Object.fromEntries(
  readFileSync(join(root, "services/api/.dev.vars"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;
const AUTH = vars.SUPABASE_AUTH_URL ?? "http://localhost:9999";
const ADMIN_SECRET = vars.SUPABASE_ADMIN_SECRET ?? "";
const DB = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:arms_dev_pw@127.0.0.1:55433/arms";

async function authUser(email: string, password: string): Promise<string> {
  const res = await fetch(`${AUTH}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}`, apikey: ADMIN_SECRET },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = (await res.json()) as { id?: string };
  if (!res.ok || !body.id) throw new Error(`GoTrue admin/users failed: ${res.status}`);
  return body.id;
}

async function enrollTotp(email: string, password: string): Promise<string> {
  const tok = (await (await fetch(`${AUTH}/token?grant_type=password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json()) as {
    access_token: string;
  };
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${tok.access_token}` };
  const factor = (await (await fetch(`${AUTH}/factors`, { method: "POST", headers: h, body: JSON.stringify({ factor_type: "totp", friendly_name: "e2e" }) })).json()) as {
    id: string;
    totp: { secret: string };
  };
  const challenge = (await (await fetch(`${AUTH}/factors/${factor.id}/challenge`, { method: "POST", headers: h, body: "{}" })).json()) as { id: string };
  const verify = await fetch(`${AUTH}/factors/${factor.id}/verify`, { method: "POST", headers: h, body: JSON.stringify({ challenge_id: challenge.id, code: totp(factor.totp.secret) }) });
  if (!verify.ok) throw new Error(`TOTP verify failed: ${verify.status}`);
  return factor.totp.secret;
}

export default async function globalSetup() {
  const stamp = Date.now().toString(36);
  const password = `E2e-${stamp}-Pass!`;
  const adminEmail = `e2e-admin-${stamp}@arms.local`;
  const teacherEmail = `e2e-teacher-${stamp}@arms.local`;
  const adminId = await authUser(adminEmail, password);
  const teacherId = await authUser(teacherEmail, password);
  const totpSecret = await enrollTotp(adminEmail, password);

  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  try {
    await client.query("BEGIN");
    const org = (await client.query("INSERT INTO app.organizations(name) VALUES ($1) RETURNING id", [`E2E組織 ${stamp}`])).rows[0].id as string;
    await client.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, '山田 太郎', $2), ($3, '田中 祥司', $4)", [adminId, adminEmail, teacherId, teacherEmail]);
    await client.query("INSERT INTO app.memberships(org_id, id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'teacher')", [org, adminId, teacherId]);
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
