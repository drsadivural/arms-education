/**
 * Fixture builders. They write through the owner pool (bypassing RLS) so each test can create an isolated
 * organisation; API calls under test always go through the RLS-enforced runtime role.
 */
import type pg from "pg";

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1e4)}`;

export async function createOrg(admin: pg.Pool, name = `テスト組織-${uniq()}`, settings: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await admin.query("INSERT INTO app.organizations(name, settings) VALUES ($1, $2::jsonb) RETURNING id", [name, JSON.stringify(settings)]);
  return rows[0].id;
}

export interface UserFixture {
  userId: string;
  orgId: string;
  email: string;
  displayName: string;
  role: "admin" | "teacher" | "student";
}

export async function createUser(
  admin: pg.Pool,
  orgId: string,
  role: "admin" | "teacher" | "student",
  opts: { displayName?: string; email?: string; active?: boolean; userId?: string } = {},
): Promise<UserFixture> {
  const userId = opts.userId ?? crypto.randomUUID();
  const email = opts.email ?? `${role}-${uniq()}@example.invalid`;
  const displayName = opts.displayName ?? `${{ admin: "管理者", teacher: "講師", student: "受講者" }[role]} ${uniq()}`;
  await admin.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [userId, displayName, email]);
  await admin.query("INSERT INTO app.memberships(org_id, id, role, active) VALUES ($1, $2, $3, $4)", [orgId, userId, role, opts.active ?? true]);
  return { userId, orgId, email, displayName, role };
}

export async function createTeacher(admin: pg.Pool, orgId: string, opts: { displayName?: string; department?: string; active?: boolean } = {}): Promise<UserFixture> {
  const u = await createUser(admin, orgId, "teacher", opts);
  await admin.query(
    "INSERT INTO app.teacher_profiles(org_id, id, teacher_number, kana, department_name, specialties) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    [orgId, u.userId, `T-${uniq()}`, "こうし", opts.department ?? "開発部", JSON.stringify(["IT基礎"])],
  );
  return u;
}

export async function createClassroom(
  admin: pg.Pool,
  orgId: string,
  opts: { primaryTeacherId: string; assistantTeacherIds?: string[]; capacity?: number; name?: string; startsOn?: string; endsOn?: string },
): Promise<string> {
  const { rows } = await admin.query(
    "INSERT INTO app.classrooms(org_id, name, capacity, starts_on, ends_on) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [orgId, opts.name ?? `クラス-${uniq()}`, opts.capacity ?? 30, opts.startsOn ?? "2026-10-01", opts.endsOn ?? "2026-12-31"],
  );
  const id = rows[0].id as string;
  await admin.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, true)", [orgId, id, opts.primaryTeacherId]);
  for (const t of opts.assistantTeacherIds ?? []) {
    await admin.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, false)", [orgId, id, t]);
  }
  return id;
}

export async function createStudent(
  admin: pg.Pool,
  orgId: string,
  opts: { classroomId: string; teacherId: string; displayName?: string; department?: string; active?: boolean; dueOn?: string },
): Promise<UserFixture> {
  const u = await createUser(admin, orgId, "student", { displayName: opts.displayName, active: opts.active });
  await admin.query(
    `INSERT INTO app.student_profiles(org_id, id, employee_number, kana, company_name, department_name, joined_on, classroom_id, teacher_id, training_starts_on, training_due_on, active)
     VALUES ($1, $2, $3, 'じゅこうしゃ', 'H&A', $4, '2026-10-01', $5, $6, '2026-10-01', $7, $8)`,
    [orgId, u.userId, `E-${uniq()}`, opts.department ?? "開発部", opts.classroomId, opts.teacherId, opts.dueOn ?? "2026-12-31", opts.active ?? true],
  );
  return u;
}

export interface OrgScenario {
  orgId: string;
  admin: UserFixture;
  teacher: UserFixture;
  otherTeacher: UserFixture;
  classroomId: string;
  otherClassroomId: string;
  student: UserFixture;
  student2: UserFixture;
  otherStudent: UserFixture;
}

/** Organisation with one admin, two teachers, two classrooms and students in each. */
export async function seedOrg(admin: pg.Pool, settings: Record<string, unknown> = {}): Promise<OrgScenario> {
  const orgId = await createOrg(admin, undefined, settings);
  const adminUser = await createUser(admin, orgId, "admin");
  const teacher = await createTeacher(admin, orgId, { displayName: "田中 祥司" });
  const otherTeacher = await createTeacher(admin, orgId, { displayName: "別府 悦子", department: "営業部" });
  const classroomId = await createClassroom(admin, orgId, { primaryTeacherId: teacher.userId, name: `Aクラス-${uniq()}` });
  const otherClassroomId = await createClassroom(admin, orgId, { primaryTeacherId: otherTeacher.userId, name: `Bクラス-${uniq()}` });
  const student = await createStudent(admin, orgId, { classroomId, teacherId: teacher.userId, displayName: "和田 一夫" });
  const student2 = await createStudent(admin, orgId, { classroomId, teacherId: teacher.userId, displayName: "高橋 健太" });
  const otherStudent = await createStudent(admin, orgId, { classroomId: otherClassroomId, teacherId: otherTeacher.userId, displayName: "加藤 美咲", department: "営業部" });
  return { orgId, admin: adminUser, teacher, otherTeacher, classroomId, otherClassroomId, student, student2, otherStudent };
}
