/** Reservations: list/detail, student booking and decisions (WEB-13/14, IOS-08〜10, IOS-17). */
import { Hono } from "hono";
import { z } from "zod";
import { DecisionInput, RESERVATION_SORTS, RESERVATION_STATUSES, ReservationInput, zDate, zId } from "@arms/contracts";
import type { AppContext, AppEnv } from "../../context";
import { actorTx } from "../../context";
import { requireRole } from "../../auth/middleware";
import { parseList } from "../../domain/booking/common";
import { createReservation, decideReservation, getReservation, listReservations, type DecisionAction } from "../../domain/booking/reservations";
import { validationError } from "../../http/errors";
import { requireIdempotencyKey } from "../../http/idempotency";
import { decodeCursor, encodeCursor, parseLimit } from "../../http/pagination";
import { pathId, readBody, readQuery } from "../../http/validation";
import { KeyCursor, bookingScope, httpIdempotency, respondStored, zMonth } from "./shared";

export const reservationRoutes = new Hono<AppEnv>();

const ReservationListQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  slot_id: zId.optional(),
  classroom_id: zId.optional(),
  teacher_id: zId.optional(),
  student_id: zId.optional(),
  status: z.string().max(200).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  month: zMonth.optional(),
  idempotency_key: zId.optional(),
  sort: z.enum(RESERVATION_SORTS).optional(),
});

const ReservationCursor = KeyCursor.extend({ s: z.enum(RESERVATION_SORTS) });

/** GET /reservations — student: own; teacher: own slots; admin: all. removed only when requested. */
reservationRoutes.get("/reservations", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const q = readQuery(c, ReservationListQuery);
  const limit = parseLimit(q.limit);
  const sort = q.sort ?? "starts_at";
  const cursor = decodeCursor(q.cursor, ReservationCursor);
  if (cursor && cursor.s !== sort) throw validationError({ cursor: "並び順が変わったため、一覧を再読み込みしてください。" });
  const statuses = parseList(q.status, RESERVATION_STATUSES, () => {
    throw validationError({ status: "pending・approved・rejected・cancelled・expired・removed から指定してください。" });
  });
  const checkedAt = c.get("deps").now().toISOString();
  const result = await actorTx(c, (tx) =>
    listReservations(
      tx,
      actor,
      {
        statuses,
        from: q.from,
        to: q.to,
        month: q.month,
        slot_id: q.slot_id,
        teacher_id: q.teacher_id,
        classroom_id: q.classroom_id,
        student_id: q.student_id,
        q: q.q,
        idempotency_key: q.idempotency_key?.toLowerCase(),
        sort,
        cursor: cursor ? { k: cursor.k, id: cursor.id } : null,
        limit,
      },
      checkedAt,
    ),
  );
  const nextCursor = result.more && result.last ? encodeCursor({ ...result.last, s: sort }) : null;
  return c.json({ items: result.items, next_cursor: nextCursor, checked_at: checkedAt });
});

/** GET /reservations/{id} — detail with approval history from the audit log. */
reservationRoutes.get("/reservations/:id", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const dto = await actorTx(c, (tx) => getReservation(tx, actor, id, c.get("deps").now().toISOString(), { history: true }));
  c.header("ETag", `"${dto.row_version}"`);
  return c.json(dto);
});

/**
 * POST /reservations — the student books for themself. The Idempotency-Key header is also the DB
 * idempotency key of app.create_reservation (same key + same slot → same reservation, HTTP 201).
 */
reservationRoutes.post("/reservations", requireRole("student"), async (c) => {
  const input = await readBody(c, ReservationInput);
  const key = requireIdempotencyKey(c);
  const stored = await createReservation(bookingScope(c), input.slot_id.toLowerCase(), key, httpIdempotency(c, input));
  return respondStored(c, stored);
});

function decision(action: DecisionAction) {
  return async (c: AppContext) => {
    const id = pathId(c);
    const input = await readBody(c, DecisionInput);
    requireIdempotencyKey(c);
    const stored = await decideReservation(bookingScope(c), id, action, input, httpIdempotency(c, input));
    return respondStored(c, stored);
  };
}

reservationRoutes.post("/reservations/:id/approve", requireRole("admin", "teacher"), decision("approve"));
reservationRoutes.post("/reservations/:id/reject", requireRole("admin", "teacher"), decision("reject"));
reservationRoutes.post("/reservations/:id/cancel", requireRole("student"), decision("cancel"));
reservationRoutes.post("/reservations/:id/remove", requireRole("admin", "teacher"), decision("remove"));
