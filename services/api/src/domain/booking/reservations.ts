/**
 * Reservations (予約): read scope, DTO, booking and decisions (docs/04_RESERVATION_PROGRESS_JA.md).
 *
 * Read scope: student → own; teacher → reservations on slots they teach (slot.teacher_id); admin → all.
 * Out-of-scope single resources are 404. Capacity, idempotency, time overlap and state transitions are
 * guaranteed by the database (slot row lock, unique/exclusion constraints, app.create_reservation /
 * app.change_reservation); this module orders the calls and maps outcomes to API errors:
 *   1. lazy expiries are committed in their own transaction first (RUNTIME_ROLE_JA.md), so a later
 *      failure cannot roll them back and stale pendings never block the student exclusion constraint;
 *   2. the business call runs in a second transaction together with the HTTP idempotency record.
 */
import type { RESERVATION_STATUSES, Reservation } from "@arms/contracts";
import { isValidDecisionReason } from "@arms/contracts";
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { and, ident, sql, type SqlFragment } from "../../db/sql";
import { ApiError, fail } from "../../http/errors";
import { bookingTx, directTx, effectiveStatus, iso, likePattern, tsKey, type BookingScope, type TxWrapper } from "./common";
import { dateRange } from "./slots";

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export type DecisionAction = "approve" | "reject" | "cancel" | "remove";
export type ReservationSort = "starts_at" | "-starts_at" | "-created_at";

interface ReservationRow {
  id: string;
  slot_id: string;
  student_id: string;
  status: ReservationStatus;
  starts_at: Date;
  ends_at: Date;
  expires_at: Date;
  row_version: number;
  reason: string | null;
  student_name: string;
  employee_number: string;
  slot_title: string;
  teacher_id: string;
  teacher_name: string;
  classroom_id: string;
  classroom_name: string;
  meeting_url: string | null;
  cancel_deadline: Date;
  created_at: Date;
  updated_at: Date;
  sort_key: string;
}

/** SQL visibility predicate for aliases `r` (reservations) and `s` (lesson_slots). */
export function reservationScope(actor: Actor): SqlFragment {
  switch (actor.role) {
    case "admin":
      return sql`TRUE`;
    case "teacher":
      return sql`s.teacher_id = ${actor.userId}`;
    case "student":
      return sql`r.student_id = ${actor.userId}`;
  }
}

function reservationSelect(sortKey: SqlFragment = tsKey("r.starts_at")): SqlFragment {
  return sql`
    SELECT r.id, r.slot_id, r.student_id, ${effectiveStatus("r")} AS status, r.starts_at, r.ends_at, r.expires_at, r.row_version, r.reason,
           su.display_name AS student_name, sp.employee_number, s.title AS slot_title, s.teacher_id, tu.display_name AS teacher_name,
           s.classroom_id, c.name AS classroom_name, s.meeting_url,
           s.starts_at - make_interval(secs => s.cancel_before_seconds) AS cancel_deadline,
           r.created_at, r.updated_at, ${sortKey} AS sort_key
    FROM app.reservations r
    JOIN app.lesson_slots s ON s.org_id = r.org_id AND s.id = r.slot_id
    JOIN app.users su ON su.id = r.student_id
    JOIN app.student_profiles sp ON sp.org_id = r.org_id AND sp.id = r.student_id
    JOIN app.users tu ON tu.id = s.teacher_id
    JOIN app.classrooms c ON c.org_id = s.org_id AND c.id = s.classroom_id`;
}

function toDto(row: ReservationRow, checkedAt: string): Reservation {
  return {
    id: row.id,
    slot_id: row.slot_id,
    student_id: row.student_id,
    status: row.status,
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    expires_at: iso(row.expires_at),
    row_version: row.row_version,
    reason: row.reason,
    student_name: row.student_name,
    employee_number: row.employee_number,
    slot_title: row.slot_title,
    teacher_id: row.teacher_id,
    teacher_name: row.teacher_name,
    classroom_id: row.classroom_id,
    classroom_name: row.classroom_name,
    // Callers are always the owner, the slot's teacher or an admin (reservationScope); the private lesson
    // URL is disclosed only once the reservation is approved (「予約確定」= approved).
    meeting_url: row.status === "approved" ? row.meeting_url : null,
    cancel_deadline: iso(row.cancel_deadline),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    checked_at: checkedAt,
  };
}

export interface ReservationListFilters {
  statuses: ReservationStatus[] | null;
  from?: string;
  to?: string;
  month?: string;
  slot_id?: string;
  teacher_id?: string;
  classroom_id?: string;
  student_id?: string;
  q?: string;
  idempotency_key?: string;
  sort: ReservationSort;
  cursor: { k: string; id: string } | null;
  limit: number;
}

export async function listReservations(tx: Tx, actor: Actor, f: ReservationListFilters, checkedAt: string): Promise<{ items: Reservation[]; last: { k: string; id: string } | null; more: boolean }> {
  const range = dateRange(f, actor.timezone);
  const sortColumn = f.sort === "-created_at" ? "r.created_at" : "r.starts_at";
  const desc = f.sort !== "starts_at";
  const cursorCond = f.cursor
    ? desc
      ? sql`(${ident(sortColumn)}, r.id) < (${f.cursor.k}::timestamptz, ${f.cursor.id}::uuid)`
      : sql`(${ident(sortColumn)}, r.id) > (${f.cursor.k}::timestamptz, ${f.cursor.id}::uuid)`
    : null;
  const order =
    f.sort === "starts_at" ? sql`ORDER BY r.starts_at, r.id` : f.sort === "-starts_at" ? sql`ORDER BY r.starts_at DESC, r.id DESC` : sql`ORDER BY r.created_at DESC, r.id DESC`;
  const rows = await tx.query<ReservationRow>(sql`
    ${reservationSelect(tsKey(sortColumn))}
    WHERE ${and([
      sql`r.org_id = ${actor.orgId}`,
      reservationScope(actor),
      // Soft-deleted reservations are hidden unless explicitly requested (docs/04 「通常一覧から隠す」).
      f.statuses ? sql`${effectiveStatus("r")} = ANY(${f.statuses}::text[])` : sql`r.status <> 'removed'`,
      range.start && sql`r.starts_at >= ${range.start}`,
      range.end && sql`r.starts_at < ${range.end}`,
      f.slot_id ? sql`r.slot_id = ${f.slot_id}` : null,
      f.teacher_id ? sql`s.teacher_id = ${f.teacher_id}` : null,
      f.classroom_id ? sql`s.classroom_id = ${f.classroom_id}` : null,
      f.student_id ? sql`r.student_id = ${f.student_id}` : null,
      f.q ? sql`(su.display_name ILIKE ${likePattern(f.q)} ESCAPE '\\' OR sp.employee_number ILIKE ${likePattern(f.q)} ESCAPE '\\')` : null,
      // Key lookup is limited to the caller's own requests (「キー検索→既存結果の確認」).
      f.idempotency_key ? sql`r.student_id = ${actor.userId} AND r.idempotency_key = ${f.idempotency_key}` : null,
      cursorCond,
    ])}
    ${order}
    LIMIT ${f.limit + 1}`);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  const lastRow = page[page.length - 1];
  return { items: page.map((r) => toDto(r, checkedAt)), last: lastRow ? { k: lastRow.sort_key, id: lastRow.id } : null, more };
}

export async function findReservation(tx: Tx, actor: Actor, id: string, checkedAt: string): Promise<Reservation | null> {
  const row = await tx.maybeOne<ReservationRow>(sql`${reservationSelect()} WHERE r.org_id = ${actor.orgId} AND r.id = ${id} AND ${reservationScope(actor)}`);
  return row ? toDto(row, checkedAt) : null;
}

export async function getReservation(tx: Tx, actor: Actor, id: string, checkedAt: string, opts: { history?: boolean } = {}): Promise<Reservation> {
  const dto = await findReservation(tx, actor, id, checkedAt);
  if (!dto) fail("NOT_FOUND");
  if (opts.history) {
    const history = await tx.query<{ event_type: string; status: string | null; reason: string | null; actor_name: string | null; created_at: Date }>(sql`
      SELECT a.event_type, a.payload->>'status' AS status, a.payload->>'reason' AS reason, u.display_name AS actor_name, a.created_at
      FROM app.audit_events a LEFT JOIN app.users u ON u.id = a.actor_id
      WHERE a.org_id = ${actor.orgId} AND a.entity_id = ${id} AND a.event_type LIKE 'reservation.%'
      ORDER BY a.created_at, a.id`);
    dto.history = history.map((h) => ({ event_type: h.event_type, status: h.status, reason: h.reason, actor_name: h.actor_name, created_at: iso(h.created_at) }));
  }
  return dto;
}

// ---- writes --------------------------------------------------------------------------------

/**
 * Student booking. `key` is the client Idempotency-Key and becomes the DB idempotency key of
 * app.create_reservation: same key + same slot → the existing reservation; same key + other slot → 409.
 */
export async function createReservation(
  b: BookingScope,
  slotId: string,
  key: string,
  wrap: TxWrapper = directTx,
): Promise<{ status: number; body: Reservation }> {
  if (b.actor.role !== "student") fail("FORBIDDEN");
  // 1) Release the caller's stale pending holds (slot-id order) and commit, before taking the target slot lock.
  await bookingTx(b, (tx) => tx.query(sql`SELECT app.expire_actor_pendings() AS n`));
  // 2) Book: idempotency store + app.reserve_slot (advisory key lock → slot FOR UPDATE → capacity/overlap checks).
  return bookingTx(b, (tx) =>
    wrap(tx, async () => {
      const row = await tx.one<{ r: { id: string } }>(sql`SELECT app.reserve_slot(${slotId}, ${key}) AS r`);
      return { status: 201, body: await getReservation(tx, b.actor, row.r.id, b.deps.now().toISOString()) };
    }),
  );
}

interface CurrentState {
  status: ReservationStatus;
  row_version: number;
}

const expiredError = (cur: CurrentState) => new ApiError("RESERVATION_EXPIRED", { details: { status: cur.status, row_version: cur.row_version } });

/** Commits a due expiry of this reservation (if any) and returns its current state. 404 when out of scope. */
async function expireIfDue(b: BookingScope, id: string): Promise<CurrentState> {
  return bookingTx(b, async (tx) => {
    const visible = await tx.maybeOne(sql`
      SELECT r.id FROM app.reservations r JOIN app.lesson_slots s ON s.org_id = r.org_id AND s.id = r.slot_id
      WHERE r.org_id = ${b.actor.orgId} AND r.id = ${id} AND ${reservationScope(b.actor)}`);
    if (!visible) fail("NOT_FOUND");
    await tx.query(sql`SELECT app.expire_reservation_if_due(${id}) AS expired`);
    return tx.one<CurrentState>(sql`SELECT status, row_version FROM app.reservations WHERE org_id = ${b.actor.orgId} AND id = ${id}`);
  });
}

/**
 * approve / reject (admin, slot teacher) · cancel (owner student, before the cancel deadline) ·
 * remove (admin, slot teacher; soft delete to 'removed', history kept). reject/remove need a 1〜1000 char reason.
 * A pending reservation whose hold has passed is expired and committed first; approve/reject/cancel then
 * answer 409 RESERVATION_EXPIRED with the current status in `details`.
 */
export async function decideReservation(
  b: BookingScope,
  id: string,
  action: DecisionAction,
  input: { expected_version: number; reason?: string },
  wrap: TxWrapper = directTx,
): Promise<{ status: number; body: Reservation }> {
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  if ((action === "reject" || action === "remove") && !isValidDecisionReason(reason)) {
    throw new ApiError("REASON_REQUIRED", { field_errors: { reason: "理由を入力してください（1〜1,000文字）。" } });
  }
  if (action === "cancel" ? b.actor.role !== "student" : b.actor.role === "student") fail("FORBIDDEN");

  const before = await expireIfDue(b, id);
  if (before.status === "expired" && action !== "remove") throw expiredError(before);

  try {
    return await bookingTx(b, (tx) =>
      wrap(tx, async () => {
        const cur = await tx.one<CurrentState>(sql`SELECT status, row_version FROM app.reservations WHERE org_id = ${b.actor.orgId} AND id = ${id}`);
        if (cur.status === "expired" && action !== "remove") throw expiredError(cur);
        if (cur.row_version !== input.expected_version) throw new ApiError("VERSION_CONFLICT", { details: { status: cur.status, row_version: cur.row_version } });
        if ((action === "approve" || action === "reject") && cur.status !== "pending") throw new ApiError("INVALID_STATE", { details: { status: cur.status, row_version: cur.row_version } });
        if (action === "cancel" && cur.status !== "pending" && cur.status !== "approved") throw new ApiError("INVALID_STATE", { details: { status: cur.status, row_version: cur.row_version } });
        await tx.query(sql`SELECT app.change_reservation(${id}, ${action}, ${reason}, ${input.expected_version}) AS r`);
        return { status: 200, body: await getReservation(tx, b.actor, id, b.deps.now().toISOString()) };
      }),
    );
  } catch (e) {
    // The hold may have lapsed between the two transactions: change_reservation then expired it and rolled
    // back. Commit the expiry on its own and report it.
    if (e instanceof ApiError && ["INVALID_STATE", "VERSION_CONFLICT", "CANCELLATION_CLOSED"].includes(e.code) && action !== "remove") {
      const after = await expireIfDue(b, id);
      if (after.status === "expired") throw expiredError(after);
    }
    throw e;
  }
}
