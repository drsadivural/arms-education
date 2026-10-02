/** Shared helpers of the learning module: audit/outbox writes, scope rules and value conversion. */
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { ident, sql, type SqlFragment } from "../../db/sql";

/** Appends an audit event (same transaction as the business change). Never pass secrets or file contents. */
export async function audit(tx: Tx, orgId: string, actorId: string | null, eventType: string, entityId: string | null, payload: Record<string, unknown>): Promise<void> {
  await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
    VALUES (${orgId}, ${actorId}, ${eventType}, ${entityId}, ${json(payload)}::jsonb)`);
}

/** Queues a notification-worthy event in the transactional outbox (dispatched by the notifications module). */
export async function outbox(tx: Tx, orgId: string, eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
  await tx.exec(sql`INSERT INTO app.outbox(org_id, event_type, entity_id, payload)
    VALUES (${orgId}, ${eventType}, ${entityId}, ${json(payload)}::jsonb)`);
}

/** Transaction-scoped advisory lock serialising work on one logical key (e.g. a student's progress). */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.query(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Teacher scope over students (docs/01: 担当クラスまたは担当授業): the student's assigned teacher, or any
 * teacher (primary or assistant) of the student's classroom. `alias` is the student_profiles alias.
 */
export function teacherStudentScope(alias: string, teacherId: string): SqlFragment {
  const a = ident(alias);
  return sql`(${a}.teacher_id = ${teacherId} OR EXISTS (
    SELECT 1 FROM app.classroom_teachers sct
    WHERE sct.org_id = ${a}.org_id AND sct.classroom_id = ${a}.classroom_id AND sct.teacher_id = ${teacherId}))`;
}

/** Whether the actor may see the student (admin: any in org; teacher: scope above; student: only self). */
export async function canSeeStudent(tx: Tx, actor: Actor, studentId: string): Promise<"ok" | "forbidden" | "not_found"> {
  const row = await tx.maybeOne<{ in_scope: boolean }>(sql`
    SELECT ${actor.role === "teacher" ? teacherStudentScope("sp", actor.userId) : sql`TRUE`} AS in_scope
    FROM app.student_profiles sp WHERE sp.org_id = ${actor.orgId} AND sp.id = ${studentId}`);
  if (!row) return "not_found";
  if (actor.role === "admin") return "ok";
  if (actor.role === "student") return studentId === actor.userId ? "ok" : "forbidden";
  return row.in_scope ? "ok" : "forbidden";
}

/**
 * Teachers may edit materials of a program only when they teach a classroom that uses (any version of) it.
 */
export async function teacherTeachesProgram(tx: Tx, orgId: string, teacherId: string, programId: string): Promise<boolean> {
  const row = await tx.maybeOne(sql`
    SELECT 1 FROM app.classroom_programs cp
    JOIN app.program_versions pv ON pv.org_id = cp.org_id AND pv.id = cp.program_version_id
    JOIN app.classroom_teachers ct ON ct.org_id = cp.org_id AND ct.classroom_id = cp.classroom_id
    WHERE cp.org_id = ${orgId} AND pv.program_id = ${programId} AND ct.teacher_id = ${teacherId}
    LIMIT 1`);
  return row !== null;
}

/** pg returns numeric/bigint as strings. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v);
  return 0;
}
export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}
export function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}
export function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}
/** DATE columns are returned as local-midnight Date objects by node-postgres; format them back as YYYY-MM-DD. */
export function dateOnly(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v);
}

/** Escapes LIKE wildcards in user search text. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
