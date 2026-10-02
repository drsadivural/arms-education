/**
 * Accounts for imported teachers / new employees are created through the admin invitation saga
 * (domain/admin/invitations.ts → app.invitation_jobs): Auth provider user → DB user + membership + profile
 * (one transaction) → invitation e-mail. External calls run outside DB transactions; every step is resumable.
 *
 * The saga reads the Idempotency-Key and route from the request, so each imported row runs it under its own
 * deterministic key (derived from job id + row number): a retried commit resumes the same invitation job and never
 * creates a second provider user.
 *
 * Invitations are sent only when the admin ticked 「招待メールを送信」. Otherwise the account is created with an
 * inactive membership — the saga does not invite inactive accounts — and activated right afterwards
 * (item state `pending_activation` → `applied`); the invitation job stays at 「招待メール送信待ち」 (profile_created)
 * and is sent later from 講師管理 / ユーザー管理 (resend). Passwords are never imported.
 */
import type { AppContext } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { fail } from "../../http/errors";
import { sha256Hex } from "../../auth/crypto";
import { audit } from "../admin/common";
import { runInvitation, type InvitationSpec } from "../admin/invitations";

export interface PeopleRow {
  row: number;
  after: Record<string, unknown>;
}

interface Base {
  source: "import";
  import_job_id: string;
  row: number;
  display_name: string;
  kana: string;
  email: string;
  department_name: string;
  /** Planned membership/profile state from the file. */
  active: boolean;
  /** Create the membership inactive and activate it after the saga (no invitation e-mail). */
  activate_after_profile: boolean;
}
export interface TeacherPayload extends Base {
  teacher_number: string;
}
export interface StudentPayload extends Base {
  employee_number: string;
  company_name: string;
  joined_on: string;
  classroom_id: string;
  teacher_id: string;
  training_starts_on: string;
  training_due_on: string;
}

/** Deterministic UUID-shaped key per (job, row) for the invitation saga's idempotency. */
export async function rowInvitationKey(jobId: string, row: number): Promise<string> {
  const h = await sha256Hex(`arms-import:${jobId}:${row}`);
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Request view for the saga: same actor, database handle and dependencies, but the row's own Idempotency-Key and
 * a per-row route (used in the saga's request hash).
 */
function rowContext(c: AppContext, key: string, path: string): AppContext {
  const req = {
    header: (name: string) => (name.toLowerCase() === "idempotency-key" ? key : c.req.header(name)),
    method: "POST",
    path,
  };
  return { get: c.get, var: c.var, env: c.env, req } as unknown as AppContext;
}

async function assertEmailFree(tx: Tx, email: string): Promise<void> {
  if (await tx.maybeOne(sql`SELECT 1 FROM app.users WHERE lower(email) = lower(${email})`)) {
    fail("EMAIL_TAKEN", { message_ja: "ドライランの後にこのメールアドレスが別のアカウントで登録されたため、登録していません。" });
  }
}

async function markItem(tx: Tx, orgId: string, jobId: string, row: number, userId: string, version: number, pending: boolean): Promise<void> {
  await tx.exec(sql`
    UPDATE app.import_items SET entity_id = ${userId}, committed_version = ${version}, committed_at = now(),
      commit_state = ${pending ? "pending_activation" : "applied"}, commit_message = NULL
    WHERE org_id = ${orgId} AND job_id = ${jobId} AND row_number = ${row}`);
}

async function insertAccount(tx: Tx, orgId: string, role: "teacher" | "student", p: Base, userId: string): Promise<void> {
  const membershipActive = p.active && !p.activate_after_profile;
  await tx.exec(sql`INSERT INTO app.users(id, display_name, email) VALUES (${userId}, ${p.display_name}, ${p.email})`);
  await tx.exec(sql`INSERT INTO app.memberships(org_id, id, role, active, disabled_at)
    VALUES (${orgId}, ${userId}, ${role}, ${membershipActive}, CASE WHEN ${p.active}::boolean THEN NULL ELSE now() END)`);
}

function teacherSpec(c: AppContext, p: TeacherPayload): InvitationSpec {
  const actor = c.get("actor");
  return {
    email: p.email,
    role: "teacher",
    displayName: p.display_name,
    payload: p as unknown as Record<string, unknown>,
    async precheck(tx) {
      await assertEmailFree(tx, p.email);
      const taken = await tx.maybeOne(sql`SELECT 1 FROM app.teacher_profiles WHERE org_id = ${actor.orgId} AND teacher_number = ${p.teacher_number}`);
      if (taken) fail("TEACHER_NUMBER_TAKEN", { message_ja: "ドライランの後に同じ講師番号の講師が登録されたため、登録していません。" });
    },
    async createProfile(tx, stored, userId) {
      const s = stored as unknown as TeacherPayload;
      await insertAccount(tx, actor.orgId, "teacher", s, userId);
      const profile = await tx.one<{ row_version: number }>(sql`
        INSERT INTO app.teacher_profiles(org_id, id, teacher_number, kana, department_name)
        VALUES (${actor.orgId}, ${userId}, ${s.teacher_number}, ${s.kana}, ${s.department_name}) RETURNING row_version`);
      await audit(tx, actor, "teacher.created", userId, {
        teacher_number: s.teacher_number,
        department_name: s.department_name,
        active: s.active,
        source: "import",
        import_job_id: s.import_job_id,
        row: s.row,
      });
      await markItem(tx, actor.orgId, s.import_job_id, s.row, userId, profile.row_version, s.active && s.activate_after_profile);
    },
  };
}

function studentSpec(c: AppContext, p: StudentPayload): InvitationSpec {
  const actor = c.get("actor");
  return {
    email: p.email,
    role: "student",
    displayName: p.display_name,
    payload: p as unknown as Record<string, unknown>,
    async precheck(tx, jobId) {
      await assertEmailFree(tx, p.email);
      const taken = await tx.maybeOne(sql`SELECT 1 FROM app.student_profiles WHERE org_id = ${actor.orgId} AND employee_number = ${p.employee_number}`);
      if (taken) fail("EMPLOYEE_NUMBER_TAKEN", { message_ja: "ドライランの後に同じ社員番号の社員が登録されたため、登録していません。" });
      const pair = await tx.maybeOne<{ archived: boolean; teacher_active: boolean }>(sql`
        SELECT c.archived, m.active AS teacher_active FROM app.classrooms c
        JOIN app.classroom_teachers ct ON ct.org_id = c.org_id AND ct.classroom_id = c.id AND ct.teacher_id = ${p.teacher_id}
        JOIN app.memberships m ON m.org_id = ct.org_id AND m.id = ct.teacher_id
        WHERE c.org_id = ${actor.orgId} AND c.id = ${p.classroom_id}`);
      if (!pair) fail("TEACHER_CLASSROOM_MISMATCH", { message_ja: "ドライランの後にクラスの担当講師が変更されたため、登録していません。" });
      if (pair.archived) fail("CLASSROOM_ARCHIVED", { message_ja: "ドライランの後にクラスがアーカイブされたため、登録していません。" });
      if (!pair.teacher_active) fail("TEACHER_INACTIVE", { message_ja: "ドライランの後に担当講師が停止されたため、登録していません。" });
      if (p.active) {
        // Same early seat check as 新入社員管理: lock the classroom (as the capacity trigger does), then count active
        // students and other in-flight student invitations for it. The trigger stays the authoritative guarantee.
        const classroom = await tx.one<{ capacity: number }>(sql`
          SELECT capacity FROM app.classrooms WHERE org_id = ${actor.orgId} AND id = ${p.classroom_id} FOR NO KEY UPDATE`);
        const seats = await tx.one<{ used: number; in_flight: number }>(sql`
          SELECT
            (SELECT count(*)::int FROM app.student_profiles WHERE org_id = ${actor.orgId} AND classroom_id = ${p.classroom_id} AND active) AS used,
            (SELECT count(*)::int FROM app.invitation_jobs j
              WHERE j.org_id = ${actor.orgId} AND j.role = 'student' AND j.state IN ('pending', 'auth_created')
                AND j.locked_until > now() AND j.profile_payload->>'classroom_id' = ${p.classroom_id}
                AND (j.profile_payload->>'active')::boolean AND j.id IS DISTINCT FROM ${jobId}::uuid) AS in_flight`);
        if (seats.used + seats.in_flight >= classroom.capacity) {
          fail("CLASSROOM_FULL", { message_ja: "ドライランの後にクラスの定員に達したため、登録していません。" });
        }
      }
    },
    async createProfile(tx, stored, userId) {
      const s = stored as unknown as StudentPayload;
      await insertAccount(tx, actor.orgId, "student", s, userId);
      const profile = await tx.one<{ row_version: number }>(sql`
        INSERT INTO app.student_profiles(org_id, id, employee_number, kana, company_name, department_name, joined_on, classroom_id, teacher_id,
          training_starts_on, training_due_on, active)
        VALUES (${actor.orgId}, ${userId}, ${s.employee_number}, ${s.kana}, ${s.company_name}, ${s.department_name}, ${s.joined_on}::date,
          ${s.classroom_id}, ${s.teacher_id}, ${s.training_starts_on}::date, ${s.training_due_on}::date, ${s.active})
        RETURNING row_version`);
      await audit(tx, actor, "student.created", userId, {
        employee_number: s.employee_number,
        classroom_id: s.classroom_id,
        teacher_id: s.teacher_id,
        department_name: s.department_name,
        active: s.active,
        source: "import",
        import_job_id: s.import_job_id,
        row: s.row,
      });
      await markItem(tx, actor.orgId, s.import_job_id, s.row, userId, profile.row_version, s.active && s.activate_after_profile);
    },
  };
}

function payloadOf(entity: "teachers" | "students", jobId: string, item: PeopleRow, sendInvitations: boolean): TeacherPayload | StudentPayload {
  const a = item.after;
  const str = (k: string) => String(a[k] ?? "");
  const base: Base = {
    source: "import",
    import_job_id: jobId,
    row: item.row,
    display_name: str("display_name"),
    kana: str("kana"),
    email: str("email"),
    department_name: str("department_name"),
    active: a.active !== false,
    activate_after_profile: !sendInvitations,
  };
  if (entity === "teachers") return { ...base, teacher_number: str("teacher_number") };
  return {
    ...base,
    employee_number: str("employee_number"),
    company_name: str("company_name"),
    joined_on: str("joined_on"),
    classroom_id: str("classroom_id"),
    teacher_id: str("teacher_id"),
    training_starts_on: str("training_starts_on"),
    training_due_on: str("training_due_on"),
  };
}

/**
 * Creates (or resumes) the account of one imported row. Business errors (409/422) from the saga's checks are thrown
 * to the caller, which records the row as a conflict; provider/DB outages are thrown as well and fail the batch.
 */
export async function createImportedAccount(
  c: AppContext,
  entity: "teachers" | "students",
  jobId: string,
  item: PeopleRow,
  sendInvitations: boolean,
): Promise<{ userId: string }> {
  const payload = payloadOf(entity, jobId, item, sendInvitations);
  const key = await rowInvitationKey(jobId, item.row);
  const ctx = rowContext(c, key, `/api/v1/imports/${jobId}/rows/${item.row}`);
  const spec = entity === "teachers" ? teacherSpec(c, payload as TeacherPayload) : studentSpec(c, payload as StudentPayload);
  const outcome = await runInvitation(ctx, spec);
  return { userId: outcome.userId };
}

/** Second half of the no-invitation path: activates the membership created inactive by the saga. */
export async function activateImportedAccount(tx: Tx, orgId: string, jobId: string, row: number, userId: string): Promise<void> {
  await tx.exec(sql`UPDATE app.memberships SET active = true, disabled_at = NULL, row_version = row_version + 1
    WHERE org_id = ${orgId} AND id = ${userId} AND NOT active`);
  await tx.exec(sql`UPDATE app.import_items SET commit_state = 'applied'
    WHERE org_id = ${orgId} AND job_id = ${jobId} AND row_number = ${row} AND commit_state = 'pending_activation'`);
}
