/**
 * Applying planned rows to business tables (commit). Each function runs inside one batch transaction and returns
 * a per-row result: `applied` (with the entity id and the row_version the import left behind — rollback compares
 * it) or `conflict` (the record changed after the dry run; nothing is overwritten). Unexpected database errors
 * are thrown and fail the whole batch.
 */
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, mapDbError } from "../../http/errors";
import { COMPARE_FIELDS } from "./model";

export interface ApplyItem {
  row_number: number;
  action: "create" | "update";
  entity_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown>;
  commit_state: "pending_activation" | null;
}

export interface ItemResult {
  row_number: number;
  state: "applied" | "conflict";
  entity_id: string | null;
  version: number | null;
  message: string | null;
}

export interface AuditEvent {
  event_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
}

export interface ApplyContext {
  tx: Tx;
  actor: Actor;
  jobId: string;
  sourceSystem: string;
}

/** Codes that mean "this row no longer fits the current data" rather than an outage. */
const TRANSIENT = new Set(["IDEMPOTENCY_IN_PROGRESS", "IDEMPOTENCY_CONFLICT", "INVITATION_IN_PROGRESS", "IMPORT_IN_PROGRESS", "RATE_LIMITED"]);
export function isRowConflict(e: ApiError): boolean {
  return (e.status === 409 || e.status === 422) && !TRANSIENT.has(e.code);
}

/** Runs `fn` under a savepoint: a business error rolls back only this row and is returned as a conflict. */
export async function underSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: ApiError }> {
  await tx.exec(sql`SAVEPOINT import_row`);
  try {
    const value = await fn();
    await tx.exec(sql`RELEASE SAVEPOINT import_row`);
    return { ok: true, value };
  } catch (e) {
    await tx.exec(sql`ROLLBACK TO SAVEPOINT import_row`);
    const mapped = e instanceof ApiError ? e : mapDbError(e);
    if (mapped && isRowConflict(mapped)) return { ok: false, error: mapped };
    throw e;
  }
}

export function changes(entity: "teachers" | "classrooms" | "students" | "progress", before: Record<string, unknown> | null, after: Record<string, unknown>) {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const f of COMPARE_FIELDS[entity]) {
    if (String(before?.[f] ?? "") !== String(after[f] ?? "")) out[f] = { before: before?.[f] ?? null, after: after[f] ?? null };
  }
  return out;
}

export async function insertAudits(tx: Tx, actor: Actor, events: AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.exec(sql`
    INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
    SELECT ${actor.orgId}, ${actor.userId}, x.event_type, x.entity_id, x.payload
    FROM jsonb_to_recordset(${json(events)}::jsonb) AS x(event_type text, entity_id uuid, payload jsonb)`);
}

export async function writeCommitResults(tx: Tx, orgId: string, jobId: string, results: ItemResult[]): Promise<void> {
  if (results.length === 0) return;
  await tx.exec(sql`
    UPDATE app.import_items i SET commit_state = x.state, commit_message = x.message, entity_id = coalesce(x.entity_id, i.entity_id),
      committed_version = x.version, committed_at = now()
    FROM jsonb_to_recordset(${json(results)}::jsonb) AS x(row_number int, state text, entity_id uuid, version int, message text)
    WHERE i.org_id = ${orgId} AND i.job_id = ${jobId} AND i.row_number = x.row_number`);
}

const meta = (ctx: ApplyContext, row: number) => ({ source: "import", import_job_id: ctx.jobId, row });
const version = (before: Record<string, unknown> | null) => Number(before?.row_version ?? 0);

// ---- 教育進捗: set-based (up to 200 rows per statement) ---------------------------------------------

const PROGRESS_FIELDS = ["student_id", "teacher_id", "department_name", "teacher_name_snapshot", "due_date", "content", "notes", "state"] as const;

export async function applyProgress(ctx: ApplyContext, items: ApplyItem[]): Promise<{ results: ItemResult[]; audits: AuditEvent[] }> {
  const { tx, actor } = ctx;
  const results: ItemResult[] = [];
  const audits: AuditEvent[] = [];
  const creates = items.filter((i) => i.action === "create");
  const updates = items.filter((i) => i.action === "update");
  if (creates.length > 0) {
    const rows = creates.map((i) => ({ source_record_id: i.after_data.source_record_id, ...pick(i.after_data) }));
    const inserted = await tx.query<{ id: string; source_record_id: string; row_version: number }>(sql`
      INSERT INTO app.progress_records(org_id, student_id, teacher_id, department_name, teacher_name_snapshot, due_date, content, notes,
        source_system, source_record_id, state)
      SELECT ${actor.orgId}, x.student_id, x.teacher_id, x.department_name, x.teacher_name_snapshot, x.due_date, x.content, x.notes,
        ${ctx.sourceSystem}, x.source_record_id, x.state
      FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(student_id uuid, teacher_id uuid, department_name text, teacher_name_snapshot text,
        due_date date, content text, notes text, source_record_id text, state text)
      ON CONFLICT (org_id, source_system, source_record_id) DO NOTHING
      RETURNING id, source_record_id, row_version`);
    const bySource = new Map(inserted.map((r) => [r.source_record_id, r]));
    for (const item of creates) {
      const done = bySource.get(String(item.after_data.source_record_id));
      if (done) {
        results.push({ row_number: item.row_number, state: "applied", entity_id: done.id, version: done.row_version, message: null });
        audits.push({
          event_type: "progress_record.created",
          entity_id: done.id,
          payload: { ...meta(ctx, item.row_number), source_system: ctx.sourceSystem, source_record_id: item.after_data.source_record_id, due_date: item.after_data.due_date },
        });
      } else {
        results.push({
          row_number: item.row_number,
          state: "conflict",
          entity_id: null,
          version: null,
          message: "ドライランの後に同じ旧システムのレコードIDの進捗が登録されたため、登録していません。",
        });
      }
    }
  }
  if (updates.length > 0) {
    const rows = updates.map((i) => ({ id: i.entity_id, expected: version(i.before_data), ...pick(i.after_data) }));
    const updated = await tx.query<{ id: string; row_version: number }>(sql`
      UPDATE app.progress_records p SET student_id = x.student_id, teacher_id = x.teacher_id, department_name = x.department_name,
        teacher_name_snapshot = x.teacher_name_snapshot, due_date = x.due_date, content = x.content, notes = x.notes, state = x.state,
        row_version = p.row_version + 1
      FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(id uuid, expected int, student_id uuid, teacher_id uuid, department_name text,
        teacher_name_snapshot text, due_date date, content text, notes text, state text)
      WHERE p.org_id = ${actor.orgId} AND p.id = x.id AND p.row_version = x.expected
      RETURNING p.id, p.row_version`);
    const byId = new Map(updated.map((r) => [r.id, r.row_version]));
    for (const item of updates) {
      const v = byId.get(item.entity_id as string);
      if (v !== undefined) {
        results.push({ row_number: item.row_number, state: "applied", entity_id: item.entity_id, version: v, message: null });
        audits.push({ event_type: "progress_record.updated", entity_id: item.entity_id, payload: { ...meta(ctx, item.row_number), changes: changes("progress", item.before_data, item.after_data) } });
      } else {
        results.push({
          row_number: item.row_number,
          state: "conflict",
          entity_id: item.entity_id,
          version: null,
          message: "ドライランの後にこの進捗が編集または削除されたため、更新していません（手動で照合してください）。",
        });
      }
    }
  }
  return { results, audits };
}

function pick(after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of PROGRESS_FIELDS) out[f] = after[f] ?? (f === "notes" ? "" : null);
  return out;
}

// ---- クラス: row by row under savepoints ------------------------------------------------------------

export async function applyClassrooms(ctx: ApplyContext, items: ApplyItem[]): Promise<{ results: ItemResult[]; audits: AuditEvent[] }> {
  const { tx, actor } = ctx;
  const results: ItemResult[] = [];
  const audits: AuditEvent[] = [];
  for (const item of items) {
    const a = item.after_data;
    const outcome = await underSavepoint(tx, async () => {
      if (item.action === "create") {
        const teacher = await tx.maybeOne<{ active: boolean }>(sql`
          SELECT m.active FROM app.teacher_profiles tp JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id
          WHERE tp.org_id = ${actor.orgId} AND tp.id = ${a.primary_teacher_id as string} FOR SHARE OF m`);
        if (!teacher?.active) throw new ApiError("TEACHER_INACTIVE", { message_ja: "ドライランの後に主担当講師が停止されたため、登録していません。" });
        const created = await tx.one<{ id: string; row_version: number }>(sql`
          INSERT INTO app.classrooms(org_id, name, capacity, starts_on, ends_on)
          VALUES (${actor.orgId}, ${a.name as string}, ${a.capacity as number}, ${a.starts_on as string}::date, ${a.ends_on as string}::date)
          RETURNING id, row_version`);
        await tx.exec(sql`INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary)
          VALUES (${actor.orgId}, ${created.id}, ${a.primary_teacher_id as string}, true)`);
        await tx.exec(sql`INSERT INTO app.import_classroom_keys(org_id, source_system, classroom_code, classroom_id, job_id)
          VALUES (${actor.orgId}, ${ctx.sourceSystem}, ${a.classroom_code as string}, ${created.id}, ${ctx.jobId})`);
        const event: AuditEvent = {
          event_type: "classroom.created",
          entity_id: created.id,
          payload: { ...meta(ctx, item.row_number), name: a.name, capacity: a.capacity, starts_on: a.starts_on, ends_on: a.ends_on, primary_teacher_id: a.primary_teacher_id },
        };
        return { id: created.id, version: created.row_version, event };
      }
      const current = await tx.maybeOne<{ row_version: number }>(sql`
        SELECT row_version FROM app.classrooms WHERE org_id = ${actor.orgId} AND id = ${item.entity_id as string} FOR NO KEY UPDATE`);
      if (!current || current.row_version !== version(item.before_data)) {
        throw new ApiError("VERSION_CONFLICT", { message_ja: "ドライランの後にこのクラスが編集されたため、更新していません（手動で照合してください）。" });
      }
      const updated = await tx.one<{ row_version: number }>(sql`
        UPDATE app.classrooms SET name = ${a.name as string}, capacity = ${a.capacity as number}, starts_on = ${a.starts_on as string}::date,
          ends_on = ${a.ends_on as string}::date, row_version = row_version + 1
        WHERE org_id = ${actor.orgId} AND id = ${item.entity_id as string} RETURNING row_version`);
      const event: AuditEvent = { event_type: "classroom.updated", entity_id: item.entity_id, payload: { ...meta(ctx, item.row_number), changes: changes("classrooms", item.before_data, a) } };
      return { id: item.entity_id as string, version: updated.row_version, event };
    });
    if (outcome.ok) {
      results.push({ row_number: item.row_number, state: "applied", entity_id: outcome.value.id, version: outcome.value.version, message: null });
      audits.push(outcome.value.event);
    } else {
      const message =
        outcome.error.code === "DUPLICATE" || outcome.error.code === "CLASSROOM_NAME_TAKEN"
          ? "ドライランの後に同じ名称・開始日のクラス、または同じクラス番号が登録されたため、登録していません。"
          : outcome.error.message_ja;
      results.push({ row_number: item.row_number, state: "conflict", entity_id: item.entity_id, version: null, message });
    }
  }
  return { results, audits };
}

// ---- 講師・新入社員の更新: row by row under savepoints ---------------------------------------------

export async function applyPeopleUpdates(
  ctx: ApplyContext,
  entity: "teachers" | "students",
  items: ApplyItem[],
): Promise<{ results: ItemResult[]; audits: AuditEvent[] }> {
  const { tx, actor } = ctx;
  const results: ItemResult[] = [];
  const audits: AuditEvent[] = [];
  const table = entity === "teachers" ? sql`app.teacher_profiles` : sql`app.student_profiles`;
  for (const item of items) {
    const a = item.after_data;
    const id = item.entity_id as string;
    const outcome = await underSavepoint(tx, async () => {
      const current = await tx.maybeOne<{ row_version: number }>(sql`SELECT row_version FROM ${table} WHERE org_id = ${actor.orgId} AND id = ${id} FOR NO KEY UPDATE`);
      if (!current || current.row_version !== version(item.before_data)) {
        throw new ApiError("VERSION_CONFLICT", {
          message_ja: `ドライランの後にこの${entity === "teachers" ? "講師" : "社員"}の情報が編集されたため、更新していません（手動で照合してください）。`,
        });
      }
      await tx.exec(sql`UPDATE app.users SET display_name = ${a.display_name as string} WHERE id = ${id}`);
      const updated =
        entity === "teachers"
          ? await tx.one<{ row_version: number }>(sql`
              UPDATE app.teacher_profiles SET kana = ${a.kana as string}, department_name = ${a.department_name as string}, row_version = row_version + 1
              WHERE org_id = ${actor.orgId} AND id = ${id} RETURNING row_version`)
          : await tx.one<{ row_version: number }>(sql`
              UPDATE app.student_profiles SET kana = ${a.kana as string}, company_name = ${a.company_name as string},
                department_name = ${a.department_name as string}, joined_on = ${a.joined_on as string}::date,
                training_starts_on = ${a.training_starts_on as string}::date, training_due_on = ${a.training_due_on as string}::date,
                row_version = row_version + 1
              WHERE org_id = ${actor.orgId} AND id = ${id} RETURNING row_version`);
      return updated.row_version;
    });
    if (outcome.ok) {
      results.push({ row_number: item.row_number, state: "applied", entity_id: id, version: outcome.value, message: null });
      audits.push({
        event_type: entity === "teachers" ? "teacher.updated" : "student.updated",
        entity_id: id,
        payload: { ...meta(ctx, item.row_number), changes: changes(entity, item.before_data, a) },
      });
    } else results.push({ row_number: item.row_number, state: "conflict", entity_id: id, version: null, message: outcome.error.message_ja });
  }
  return { results, audits };
}
