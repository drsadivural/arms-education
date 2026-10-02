/**
 * Lesson slots (授業・予約枠): read scope, DTO, create/update and cancellation.
 *
 * Read scope (enforced in SQL, RLS only isolates organisations):
 *   admin   — every slot of the organisation
 *   teacher — slots of classrooms they teach (classroom_teachers)
 *   student — slots of their current classroom, plus slots they hold a reservation for
 * `remaining` = capacity − (pending not yet expired + approved), computed by the query at read time.
 * `meeting_url` is returned only to admins, the slot's teacher and a student whose reservation is approved.
 */
import type { LessonSlot, SlotInputT } from "@arms/contracts";
import { zonedDayRange, zonedMonthRange } from "@arms/contracts";
import type { Actor } from "../../context";
import type { Config } from "../../env";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { and, empty, sql, type SqlFragment } from "../../db/sql";
import { ApiError, fail, validationError } from "../../http/errors";
import { effectiveStatus, iso, likePattern, tsKey } from "./common";

export interface SlotRow {
  id: string;
  classroom_id: string;
  teacher_id: string;
  unit_id: string | null;
  title: string;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  booking_closes_at: Date;
  meeting_url: string | null;
  cancel_before_seconds: number;
  pending_ttl_seconds: number;
  state: "open" | "closed" | "cancelled";
  row_version: number;
  teacher_name: string;
  classroom_name: string;
  pending_count: number;
  approved_count: number;
  my_reservation_id: string | null;
  my_reservation_status: NonNullable<LessonSlot["my_reservation"]>["status"] | null;
  cursor_ts: string;
}

/** SQL visibility predicate for alias `s` (app.lesson_slots). */
export function slotScope(actor: Actor): SqlFragment {
  switch (actor.role) {
    case "admin":
      return sql`TRUE`;
    case "teacher":
      return sql`EXISTS (SELECT 1 FROM app.classroom_teachers ct
        WHERE ct.org_id = s.org_id AND ct.classroom_id = s.classroom_id AND ct.teacher_id = ${actor.userId})`;
    case "student":
      return sql`(s.classroom_id = (SELECT sp.classroom_id FROM app.student_profiles sp WHERE sp.org_id = s.org_id AND sp.id = ${actor.userId} AND sp.active)
        OR EXISTS (SELECT 1 FROM app.reservations rr WHERE rr.org_id = s.org_id AND rr.slot_id = s.id AND rr.student_id = ${actor.userId}))`;
  }
}

function slotSelect(actor: Actor): SqlFragment {
  const student = actor.role === "student";
  return sql`
    SELECT s.id, s.classroom_id, s.teacher_id, s.unit_id, s.title, s.starts_at, s.ends_at, s.capacity, s.booking_closes_at,
           s.meeting_url, s.cancel_before_seconds, s.pending_ttl_seconds, s.state, s.row_version,
           tu.display_name AS teacher_name, c.name AS classroom_name,
           cnt.pending_count, cnt.approved_count, ${tsKey("s.starts_at")} AS cursor_ts,
           ${student ? sql`mine.id AS my_reservation_id, mine.status AS my_reservation_status` : sql`NULL::uuid AS my_reservation_id, NULL::text AS my_reservation_status`}
    FROM app.lesson_slots s
    JOIN app.users tu ON tu.id = s.teacher_id
    JOIN app.classrooms c ON c.org_id = s.org_id AND c.id = s.classroom_id
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE r.status = 'pending' AND r.expires_at > now())::int AS pending_count,
             count(*) FILTER (WHERE r.status = 'approved')::int AS approved_count
      FROM app.reservations r
      WHERE r.org_id = s.org_id AND r.slot_id = s.id AND r.status IN ('pending', 'approved')
    ) cnt
    ${
      student
        ? sql`LEFT JOIN LATERAL (
            SELECT r.id, ${effectiveStatus("r")} AS status
            FROM app.reservations r
            WHERE r.org_id = s.org_id AND r.slot_id = s.id AND r.student_id = ${actor.userId}
            ORDER BY (r.status = 'approved' OR (r.status = 'pending' AND r.expires_at > now())) DESC, (r.status <> 'removed') DESC, r.created_at DESC
            LIMIT 1) mine ON TRUE`
        : empty
    }`;
}

export function toSlotDto(row: SlotRow, actor: Actor): LessonSlot {
  const canSeeUrl =
    actor.role === "admin" ||
    (actor.role === "teacher" && row.teacher_id === actor.userId) ||
    (actor.role === "student" && row.my_reservation_status === "approved");
  const remaining = row.state === "cancelled" ? 0 : Math.max(0, row.capacity - row.pending_count - row.approved_count);
  const dto: LessonSlot = {
    id: row.id,
    classroom_id: row.classroom_id,
    teacher_id: row.teacher_id,
    unit_id: row.unit_id,
    title: row.title,
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    capacity: row.capacity,
    booking_closes_at: iso(row.booking_closes_at),
    meeting_url: canSeeUrl ? row.meeting_url : null,
    has_meeting_url: row.meeting_url !== null,
    cancel_before_seconds: row.cancel_before_seconds,
    teacher_name: row.teacher_name,
    classroom_name: row.classroom_name,
    remaining,
    state: row.state,
    row_version: row.row_version,
  };
  if (actor.role === "student") {
    dto.my_reservation = row.my_reservation_id && row.my_reservation_status ? { id: row.my_reservation_id, status: row.my_reservation_status } : null;
  } else {
    dto.pending_count = row.pending_count;
    dto.approved_count = row.approved_count;
  }
  return dto;
}

export interface SlotListFilters {
  q?: string;
  classroom_id?: string;
  teacher_id?: string;
  states: ("open" | "closed" | "cancelled")[] | null;
  from?: string;
  to?: string;
  month?: string;
  cursor: { k: string; id: string } | null;
  limit: number;
}

/** Instant range from JST (organisation timezone) date filters; null bounds mean open-ended. */
export function dateRange(f: { from?: string; to?: string; month?: string }, timezone: string): { start: Date | null; end: Date | null } {
  let start: Date | null = null;
  let end: Date | null = null;
  if (f.month) {
    const m = zonedMonthRange(f.month, timezone);
    start = m.start;
    end = m.end;
  }
  if (f.from) {
    const s = zonedDayRange(f.from, timezone).start;
    if (!start || s > start) start = s;
  }
  if (f.to) {
    const e = zonedDayRange(f.to, timezone).end;
    if (!end || e < end) end = e;
  }
  if (f.from && f.to && f.from > f.to) throw validationError({ to: "終了日は開始日以降にしてください。" });
  return { start, end };
}

export async function listSlots(tx: Tx, actor: Actor, f: SlotListFilters): Promise<SlotRow[]> {
  const range = dateRange(f, actor.timezone);
  const explicitRange = range.start !== null || range.end !== null;
  const states = f.states ?? (actor.role === "student" ? ["open"] : ["open", "closed"]);
  return tx.query<SlotRow>(sql`
    ${slotSelect(actor)}
    WHERE ${and([
      sql`s.org_id = ${actor.orgId}`,
      slotScope(actor),
      sql`s.state = ANY(${states}::text[])`,
      f.classroom_id ? sql`s.classroom_id = ${f.classroom_id}` : null,
      f.teacher_id ? sql`s.teacher_id = ${f.teacher_id}` : null,
      f.q ? sql`s.title ILIKE ${likePattern(f.q)} ESCAPE '\\'` : null,
      range.start && sql`s.starts_at >= ${range.start}`,
      range.end && sql`s.starts_at < ${range.end}`,
      // Default window: upcoming (students: not yet started; staff: not yet ended).
      !explicitRange && (actor.role === "student" ? sql`s.starts_at > now()` : sql`s.ends_at > now()`),
      f.cursor && sql`(s.starts_at, s.id) > (${f.cursor.k}::timestamptz, ${f.cursor.id}::uuid)`,
    ])}
    ORDER BY s.starts_at, s.id
    LIMIT ${f.limit + 1}`);
}

export async function findSlot(tx: Tx, actor: Actor, id: string): Promise<SlotRow | null> {
  return tx.maybeOne<SlotRow>(sql`${slotSelect(actor)} WHERE s.org_id = ${actor.orgId} AND s.id = ${id} AND ${slotScope(actor)}`);
}

export async function getSlot(tx: Tx, actor: Actor, id: string): Promise<SlotRow> {
  const row = await findSlot(tx, actor, id);
  if (!row) fail("NOT_FOUND");
  return row;
}

/** Today's lessons in the organisation timezone: teacher → own slots; student → slots with an approved reservation. */
export async function listTodayLessons(tx: Tx, actor: Actor, today: string, cursor: { k: string; id: string } | null, limit: number): Promise<SlotRow[]> {
  const day = zonedDayRange(today, actor.timezone);
  const who =
    actor.role === "teacher"
      ? sql`s.teacher_id = ${actor.userId}`
      : sql`EXISTS (SELECT 1 FROM app.reservations r WHERE r.org_id = s.org_id AND r.slot_id = s.id AND r.student_id = ${actor.userId} AND r.status = 'approved')`;
  return tx.query<SlotRow>(sql`
    ${slotSelect(actor)}
    WHERE ${and([
      sql`s.org_id = ${actor.orgId}`,
      who,
      sql`s.state <> 'cancelled'`,
      sql`s.starts_at >= ${day.start}`,
      sql`s.starts_at < ${day.end}`,
      cursor && sql`(s.starts_at, s.id) > (${cursor.k}::timestamptz, ${cursor.id}::uuid)`,
    ])}
    ORDER BY s.starts_at, s.id
    LIMIT ${limit + 1}`);
}

// ---- writes --------------------------------------------------------------------------------

interface BookingDefaults {
  cancelBeforeSeconds: number;
  pendingTtlSeconds: number;
}

/** Booking defaults: organizations.settings, else the deployment configuration. */
export async function bookingDefaults(tx: Tx, orgId: string, config: Config): Promise<BookingDefaults> {
  const row = await tx.one<{ settings: Record<string, unknown> }>(sql`SELECT settings FROM app.organizations WHERE id = ${orgId}`);
  const pick = (key: string, fallback: number, min: number) => {
    const v = row.settings?.[key];
    return typeof v === "number" && Number.isInteger(v) && v >= min ? v : fallback;
  };
  return {
    cancelBeforeSeconds: pick("booking_cancel_before_seconds", config.booking.cancelBeforeSeconds, 0),
    pendingTtlSeconds: pick("booking_pending_ttl_seconds", config.booking.pendingTtlSeconds, 1),
  };
}

/** Checks the classroom/teacher/unit references of a slot input (422 with Japanese field errors). */
async function validateSlotRefs(tx: Tx, orgId: string, input: SlotInputT): Promise<void> {
  const classroom = await tx.maybeOne<{ archived: boolean }>(sql`SELECT archived FROM app.classrooms WHERE org_id = ${orgId} AND id = ${input.classroom_id}`);
  if (!classroom) throw validationError({ classroom_id: "クラスが見つかりません。" });
  if (classroom.archived) throw validationError({ classroom_id: "終了したクラスには授業枠を作成できません。" });
  const teacher = await tx.maybeOne<{ active: boolean }>(sql`
    SELECT m.active FROM app.classroom_teachers ct JOIN app.memberships m ON m.org_id = ct.org_id AND m.id = ct.teacher_id AND m.role = 'teacher'
    WHERE ct.org_id = ${orgId} AND ct.classroom_id = ${input.classroom_id} AND ct.teacher_id = ${input.teacher_id}`);
  if (!teacher) throw new ApiError("TEACHER_CLASSROOM_MISMATCH", { field_errors: { teacher_id: "選択した講師はこのクラスの担当ではありません。" } });
  if (!teacher.active) throw new ApiError("TEACHER_INACTIVE", { field_errors: { teacher_id: "停止中の講師は選択できません。" } });
  if (input.unit_id) {
    const unit = await tx.maybeOne(sql`SELECT 1 AS ok FROM app.units WHERE org_id = ${orgId} AND id = ${input.unit_id}`);
    if (!unit) throw validationError({ unit_id: "単元が見つかりません。" });
  }
}

function auditSlot(input: { title: string; classroom_id: string; teacher_id: string; unit_id: string | null; starts_at: string | Date; ends_at: string | Date; capacity: number; booking_closes_at: string | Date; cancel_before_seconds: number; state: string; meeting_url: string | null }) {
  return {
    title: input.title,
    classroom_id: input.classroom_id,
    teacher_id: input.teacher_id,
    unit_id: input.unit_id,
    starts_at: iso(input.starts_at),
    ends_at: iso(input.ends_at),
    capacity: input.capacity,
    booking_closes_at: iso(input.booking_closes_at),
    cancel_before_seconds: input.cancel_before_seconds,
    state: input.state,
    has_meeting_url: input.meeting_url !== null,
  };
}

export async function createSlot(tx: Tx, actor: Actor, config: Config, now: Date, input: SlotInputT): Promise<string> {
  if (actor.role === "teacher" && input.teacher_id !== actor.userId) {
    fail("FORBIDDEN", { message_ja: "講師は自分が担当する授業枠のみ作成できます。" });
  }
  if (new Date(input.starts_at) <= now) throw validationError({ starts_at: "開始時刻は現在より後にしてください。" });
  await validateSlotRefs(tx, actor.orgId, input);
  const defaults = await bookingDefaults(tx, actor.orgId, config);
  const created = await tx.one<{ id: string }>(sql`
    INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, unit_id, title, starts_at, ends_at, capacity, booking_closes_at,
                                 cancel_before_seconds, pending_ttl_seconds, state, meeting_url)
    VALUES (${actor.orgId}, ${input.classroom_id}, ${input.teacher_id}, ${input.unit_id ?? null}, ${input.title}, ${input.starts_at}, ${input.ends_at},
            ${input.capacity}, ${input.booking_closes_at}, ${input.cancel_before_seconds ?? defaults.cancelBeforeSeconds}, ${defaults.pendingTtlSeconds},
            ${input.state ?? "open"}, ${input.meeting_url ?? null})
    RETURNING id`);
  const after = auditSlot({
    ...input,
    unit_id: input.unit_id ?? null,
    meeting_url: input.meeting_url ?? null,
    cancel_before_seconds: input.cancel_before_seconds ?? defaults.cancelBeforeSeconds,
    state: input.state ?? "open",
  });
  await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
    VALUES (${actor.orgId}, ${actor.userId}, 'lesson_slot.created', ${created.id}, ${json({ after })}::jsonb)`);
  return created.id;
}

export async function updateSlot(tx: Tx, actor: Actor, now: Date, id: string, expectedVersion: number, input: SlotInputT): Promise<void> {
  const current = await findSlot(tx, actor, id);
  if (!current) fail("NOT_FOUND");
  if (actor.role === "teacher") {
    if (current.teacher_id !== actor.userId) fail("FORBIDDEN", { message_ja: "担当していない授業枠は編集できません。" });
    if (input.teacher_id !== actor.userId) fail("FORBIDDEN", { message_ja: "講師は自分が担当する授業枠のみ編集できます。" });
  }
  if (current.state === "cancelled") fail("SLOT_CANCELLED");
  if (current.row_version !== expectedVersion) fail("VERSION_CONFLICT");
  if (new Date(input.starts_at).getTime() !== current.starts_at.getTime() && new Date(input.starts_at) <= now) {
    throw validationError({ starts_at: "開始時刻は現在より後にしてください。" });
  }
  await validateSlotRefs(tx, actor.orgId, input);
  const next = {
    title: input.title,
    classroom_id: input.classroom_id,
    teacher_id: input.teacher_id,
    unit_id: input.unit_id ?? null,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    capacity: input.capacity,
    booking_closes_at: input.booking_closes_at,
    cancel_before_seconds: input.cancel_before_seconds ?? current.cancel_before_seconds,
    state: input.state ?? current.state,
    meeting_url: input.meeting_url ?? null,
  };
  // The slot_active_guard trigger rejects time/teacher/classroom changes and capacity decreases while
  // pending/approved reservations exist (ACTIVE_RESERVATIONS); exclusion constraints → SLOT_TIME_CONFLICT.
  const updated = await tx.maybeOne<{ row_version: number }>(sql`
    UPDATE app.lesson_slots SET
      title = ${next.title}, classroom_id = ${next.classroom_id}, teacher_id = ${next.teacher_id}, unit_id = ${next.unit_id},
      starts_at = ${next.starts_at}, ends_at = ${next.ends_at}, capacity = ${next.capacity}, booking_closes_at = ${next.booking_closes_at},
      cancel_before_seconds = ${next.cancel_before_seconds}, state = ${next.state}, meeting_url = ${next.meeting_url},
      row_version = row_version + 1
    WHERE org_id = ${actor.orgId} AND id = ${id} AND row_version = ${expectedVersion}
    RETURNING row_version`);
  if (!updated) fail("VERSION_CONFLICT");
  await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
    VALUES (${actor.orgId}, ${actor.userId}, 'lesson_slot.updated', ${id}, ${json({
      before: auditSlot(current),
      after: auditSlot(next),
      meeting_url_changed: (current.meeting_url ?? null) !== next.meeting_url,
    })}::jsonb)`);
}

/** Cancels the slot and all its active reservations (SQL function app.cancel_slot). */
export async function cancelSlot(tx: Tx, actor: Actor, id: string, reason: string, expectedVersion: number): Promise<Record<string, unknown>> {
  const visible = await findSlot(tx, actor, id);
  if (!visible) fail("NOT_FOUND");
  if (actor.role === "teacher" && visible.teacher_id !== actor.userId) fail("FORBIDDEN", { message_ja: "担当していない授業枠は取り消せません。" });
  if (visible.state === "cancelled") fail("SLOT_CANCELLED");
  const row = await tx.one<{ result: Record<string, unknown> }>(sql`SELECT app.cancel_slot(${id}, ${reason}, ${expectedVersion}) AS result`);
  return row.result;
}
