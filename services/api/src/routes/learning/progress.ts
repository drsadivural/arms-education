/** Student progress (IOS-04/05/06, WEB-12) and legacy 社員教育進捗管理 records (WEB-11/12). */
import { Hono } from "hono";
import { z } from "zod";
import { ProgressRecordInput, ProgressRecordUpdateInput, zonedDateString } from "@arms/contracts";
import type { Actor, AppContext, AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { ApiError, fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { ok, page } from "../../http/respond";
import { pathId, readBody, readQuery, requireIfMatch } from "../../http/validation";
import { audit, canSeeStudent, dateOnly, iso, teacherStudentScope } from "../../domain/learning/common";
import { RECORD_ORDER, recordDto, recordSelect, recordWhere, type RecordRow } from "../../domain/learning/progress-records";
import { readStudentProgress } from "../../domain/progress";

export const progressRoutes = new Hono<AppEnv>();

export function orgToday(c: AppContext): string {
  return zonedDateString(c.get("deps").now(), c.get("actor").timezone);
}

/** GET /students/{id}/progress — admin, the student themself, or a teacher of the student (others: 403). */
progressRoutes.get("/students/:id/progress", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const today = orgToday(c);
  const dto = await actorTx(c, async (tx) => {
    const access = await canSeeStudent(tx, actor, id);
    if (access === "not_found") fail(actor.role === "student" ? "FORBIDDEN" : "NOT_FOUND");
    if (access === "forbidden") fail("FORBIDDEN");
    const progress = await readStudentProgress(tx, actor.orgId, id, today);
    if (!progress) fail("NOT_FOUND");
    return progress;
  });
  return c.json({ ...dto, checked_at: c.get("deps").now().toISOString() });
});

// ---- legacy progress records -------------------------------------------------------------------

const STATUS = z.enum(["unverified", "not_started", "in_progress", "review_pending", "completed", "overdue"]);
const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.string().optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "YYYY-MM形式で指定してください。" }).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  department: z.string().trim().min(1).max(100).optional(),
  teacher_id: z.guid().optional(),
  classroom_id: z.guid().optional(),
  student_id: z.guid().optional(),
  status: STATUS.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
const RecordCursor = z.object({ d: z.iso.date(), n: z.string(), i: z.guid() });

/** GET /progress-records — ordered by 終了予定日, 社員名; filters month/部署/講師/クラス/状態(期限超過)/検索. */
progressRoutes.get("/progress-records", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const q = readQuery(c, ListQuery);
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, RecordCursor);
  const today = orgToday(c);
  const rows = await actorTx(c, (tx) =>
    tx.query<RecordRow>(sql`${recordSelect(today)}
      WHERE ${recordWhere(actor, q, today)}
      ${cursor ? sql`AND (pr.due_date, su.display_name, pr.id) > (${cursor.d}::date, ${cursor.n}, ${cursor.i}::uuid)` : sql``}
      ${RECORD_ORDER} LIMIT ${limit + 1}`),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ d: dateOnly(r.due_date), n: r.student_name, i: r.id }));
  return page(c, items.map(recordDto), nextCursor);
});

async function loadRecord(tx: Tx, actor: Actor, id: string, today: string): Promise<RecordRow> {
  const row = await tx.maybeOne<RecordRow & { in_scope: boolean }>(sql`
    SELECT x.*, ${actor.role === "teacher" ? sql`(x.teacher_id = ${actor.userId} OR ${teacherStudentScope("sp", actor.userId)})` : sql`TRUE`} AS in_scope
    FROM (${recordSelect(today)} WHERE pr.org_id = ${actor.orgId} AND pr.id = ${id}) x
    JOIN app.student_profiles sp ON sp.org_id = ${actor.orgId} AND sp.id = x.student_id`);
  if (!row) fail("NOT_FOUND");
  if (!row.in_scope) fail("FORBIDDEN");
  return row;
}

/** UUIDs are compared as strings below; the DB returns them lower-case. */
function lowerIds<T extends { student_id: string; teacher_id: string }>(input: T): T {
  return { ...input, student_id: input.student_id.toLowerCase(), teacher_id: input.teacher_id.toLowerCase() };
}

interface PartyCheck {
  teacherName: string;
}

/**
 * Validates the student/teacher of a record and the teacher caller's scope (docs/01: 担当外は403). Teachers may
 * attach records only to students they teach and may only name themselves as 教育担当者 when setting/changing it;
 * an existing record they can see (as 教育担当者 or as the student's teacher) stays editable as-is.
 */
async function checkParties(
  tx: Tx,
  actor: Actor,
  input: { student_id: string; teacher_id: string },
  previous: { student_id: string; teacher_id: string } | null,
): Promise<PartyCheck> {
  const student = await tx.maybeOne<{ in_scope: boolean }>(sql`
    SELECT ${actor.role === "teacher" ? teacherStudentScope("sp", actor.userId) : sql`TRUE`} AS in_scope
    FROM app.student_profiles sp WHERE sp.org_id = ${actor.orgId} AND sp.id = ${input.student_id}`);
  if (!student) throw new ApiError("VALIDATION_FAILED", { field_errors: { student_id: "新入社員が見つかりません。" } });
  const teacher = await tx.maybeOne<{ display_name: string; active: boolean }>(sql`
    SELECT u.display_name, m.active FROM app.teacher_profiles tp
    JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id
    JOIN app.users u ON u.id = tp.id
    WHERE tp.org_id = ${actor.orgId} AND tp.id = ${input.teacher_id}`);
  if (!teacher) throw new ApiError("VALIDATION_FAILED", { field_errors: { teacher_id: "講師が見つかりません。" } });
  const teacherChanged = previous?.teacher_id !== input.teacher_id;
  const studentChanged = previous?.student_id !== input.student_id;
  if (teacherChanged && !teacher.active) throw new ApiError("TEACHER_INACTIVE", { field_errors: { teacher_id: "停止中の講師は選択できません。" } });
  if (actor.role === "teacher") {
    if (teacherChanged && input.teacher_id !== actor.userId) fail("FORBIDDEN");
    if (studentChanged && !student.in_scope) fail("FORBIDDEN");
  }
  return { teacherName: teacher.display_name };
}

/** POST /progress-records — 旧形式の教育記録を登録. */
progressRoutes.post("/progress-records", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const input = lowerIds(await readBody(c, ProgressRecordInput));
  const today = orgToday(c);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const parties = await checkParties(tx, actor, input, null);
      const created = await tx.one<{ id: string }>(sql`
        INSERT INTO app.progress_records(org_id, student_id, teacher_id, department_name, teacher_name_snapshot, due_date, content, notes, state, created_by)
        VALUES (${actor.orgId}, ${input.student_id}, ${input.teacher_id}, ${input.department_name}, ${parties.teacherName}, ${input.due_date},
                ${input.content}, ${input.notes ?? ""}, ${input.state}, ${actor.userId})
        RETURNING id`);
      await audit(tx, actor.orgId, actor.userId, "progress_record.created", created.id, {
        changes: Object.fromEntries(
          Object.entries({ ...input, notes: input.notes ?? "", teacher_name: parties.teacherName }).map(([k, v]) => [k, { before: null, after: v }]),
        ),
      });
      return { status: 200, body: recordDto(await loadRecord(tx, actor, created.id, today)) };
    }),
  );
  return ok(c, result.body, { version: result.body.row_version });
});

const HISTORY_LIMIT = 200;

/** GET /progress-records/{id} — record + correction history (before/after, reason, actor, time). */
progressRoutes.get("/progress-records/:id", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const today = orgToday(c);
  const dto = await actorTx(c, async (tx) => {
    const row = await loadRecord(tx, actor, id, today);
    const events = await tx.query<{ id: string; event_type: string; actor_id: string | null; actor_name: string | null; created_at: Date; payload: Record<string, unknown> }>(sql`
      SELECT a.id, a.event_type, a.actor_id, u.display_name AS actor_name, a.created_at, a.payload
      FROM app.audit_events a LEFT JOIN app.users u ON u.id = a.actor_id
      WHERE a.org_id = ${actor.orgId} AND a.entity_id = ${id}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${HISTORY_LIMIT}`);
    return {
      ...recordDto(row),
      history: events.map((e) => {
        const changes = e.payload && typeof e.payload.changes === "object" && e.payload.changes !== null ? e.payload.changes : {};
        return {
          id: e.id,
          event_type: e.event_type,
          actor_id: e.actor_id,
          actor_name: e.actor_name,
          created_at: iso(e.created_at),
          reason: typeof e.payload?.reason === "string" ? e.payload.reason : null,
          changes,
        };
      }),
    };
  });
  return ok(c, dto, { version: dto.row_version });
});

const EDITABLE_FIELDS = ["student_id", "teacher_id", "department_name", "due_date", "content", "notes", "state"] as const;

/** PATCH /progress-records/{id} — correction with If-Match; changing any value requires correction_reason. */
progressRoutes.patch("/progress-records/:id", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = lowerIds(await readBody(c, ProgressRecordUpdateInput));
  const today = orgToday(c);
  const dto = await actorTx(c, async (tx) => {
    const before = await loadRecord(tx, actor, id, today);
    await tx.query(sql`SELECT 1 FROM app.progress_records WHERE org_id = ${actor.orgId} AND id = ${id} FOR UPDATE`);
    const locked = await tx.one<{ row_version: number }>(sql`SELECT row_version FROM app.progress_records WHERE org_id = ${actor.orgId} AND id = ${id}`);
    if (locked.row_version !== expected) fail("VERSION_CONFLICT");
    const next = { ...input, notes: input.notes ?? "" };
    const prev: Record<string, unknown> = { ...before, due_date: dateOnly(before.due_date) };
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const f of EDITABLE_FIELDS) if (prev[f] !== next[f]) changes[f] = { before: prev[f], after: next[f] };
    if (Object.keys(changes).length === 0) return recordDto(before);
    if (!input.correction_reason) {
      throw new ApiError("REASON_REQUIRED", { message_ja: "訂正理由を入力してください。", field_errors: { correction_reason: "訂正理由を入力してください。" } });
    }
    const parties = await checkParties(tx, actor, next, { student_id: before.student_id, teacher_id: before.teacher_id });
    if (changes.teacher_id) changes.teacher_name = { before: before.teacher_name, after: parties.teacherName };
    const updated = await tx.exec(sql`
      UPDATE app.progress_records SET student_id = ${next.student_id}, teacher_id = ${next.teacher_id}, department_name = ${next.department_name},
        teacher_name_snapshot = ${changes.teacher_id ? parties.teacherName : before.teacher_name}, due_date = ${next.due_date}, content = ${next.content},
        notes = ${next.notes}, state = ${next.state}, row_version = row_version + 1, updated_at = now()
      WHERE org_id = ${actor.orgId} AND id = ${id} AND row_version = ${expected}`);
    if (updated === 0) fail("VERSION_CONFLICT");
    await audit(tx, actor.orgId, actor.userId, "progress_record.corrected", id, { changes, reason: input.correction_reason });
    return recordDto(await loadRecord(tx, actor, id, today));
  });
  return ok(c, dto, { version: dto.row_version });
});
