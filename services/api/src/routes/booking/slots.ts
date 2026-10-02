/** Lesson slots, attendance and today's lessons (WEB-15, IOS-07, IOS-11, IOS-16). */
import { Hono } from "hono";
import { z } from "zod";
import { AttendanceInput, DeactivateInput, SLOT_STATES, SlotInput, zDate, zId, zonedDateString } from "@arms/contracts";
import type { AppEnv } from "../../context";
import { actorTx } from "../../context";
import { requireRole } from "../../auth/middleware";
import { bookingTx, parseList } from "../../domain/booking/common";
import { cancelSlot, createSlot, getSlot, listSlots, listTodayLessons, toSlotDto, updateSlot } from "../../domain/booking/slots";
import { getAttendanceRoster, recordAttendance } from "../../domain/booking/attendance";
import { idempotent } from "../../http/idempotency";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { ok, page } from "../../http/respond";
import { pathId, readBody, readQuery, requireIfMatch } from "../../http/validation";
import { validationError } from "../../http/errors";
import { KeyCursor, bookingScope, httpIdempotency, respondStored, zMonth } from "./shared";

export const slotRoutes = new Hono<AppEnv>();

const SlotListQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  classroom_id: zId.optional(),
  teacher_id: zId.optional(),
  status: z.string().max(100).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  month: zMonth.optional(),
});

/** GET /lesson-slots — scoped list; remaining is aggregated by the query at read time (no caching). */
slotRoutes.get("/lesson-slots", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const q = readQuery(c, SlotListQuery);
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, KeyCursor);
  const states = parseList(q.status, SLOT_STATES, () => {
    throw validationError({ status: "open・closed・cancelled から指定してください。" });
  });
  const rows = await actorTx(c, (tx) =>
    listSlots(tx, actor, { q: q.q, classroom_id: q.classroom_id, teacher_id: q.teacher_id, states, from: q.from, to: q.to, month: q.month, cursor, limit }),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ k: r.cursor_ts, id: r.id }));
  return page(
    c,
    items.map((r) => toSlotDto(r, actor)),
    nextCursor,
  );
});

/** GET /lesson-slots/{id} */
slotRoutes.get("/lesson-slots/:id", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const row = await actorTx(c, (tx) => getSlot(tx, actor, id));
  return ok(c, toSlotDto(row, actor), { version: row.row_version });
});

/** POST /lesson-slots — admin, or a teacher for their own classroom (teacher_id must be themself). */
slotRoutes.post("/lesson-slots", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const deps = c.get("deps");
  const input = await readBody(c, SlotInput);
  const stored = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const id = await createSlot(tx, actor, deps.config, deps.now(), input);
      const row = await getSlot(tx, actor, id);
      return { status: 200, body: { data: toSlotDto(row, actor), checked_at: deps.now().toISOString() } };
    }),
  );
  return respondStored(c, stored);
});

/** PATCH /lesson-slots/{id} — If-Match row_version; active reservations block time/teacher/classroom/capacity-decrease changes (409). */
slotRoutes.patch("/lesson-slots/:id", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const deps = c.get("deps");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = await readBody(c, SlotInput);
  const row = await actorTx(c, async (tx) => {
    await updateSlot(tx, actor, deps.now(), id, expected, input);
    return getSlot(tx, actor, id);
  });
  return ok(c, toSlotDto(row, actor), { version: row.row_version });
});

/** POST /lesson-slots/{id}/cancel — cancels the slot and its active reservations with the reason; students are notified. */
slotRoutes.post("/lesson-slots/:id/cancel", requireRole("admin", "teacher"), async (c) => {
  const id = pathId(c);
  const input = await readBody(c, DeactivateInput);
  const b = bookingScope(c);
  const wrap = httpIdempotency(c, input);
  const stored = await bookingTx(b, (tx) =>
    wrap(tx, async () => ({
      status: 200,
      body: { success: true, checked_at: b.deps.now().toISOString(), data: await cancelSlot(tx, b.actor, id, input.reason, input.expected_version) },
    })),
  );
  return respondStored(c, stored);
});

/** GET /lesson-slots/{id}/attendance — roster (approved reservations + existing records). */
slotRoutes.get("/lesson-slots/:id/attendance", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const deps = c.get("deps");
  const id = pathId(c);
  const roster = await actorTx(c, (tx) => getAttendanceRoster(tx, actor, id, deps.now()));
  return ok(c, roster);
});

/** POST /lesson-slots/{id}/attendance — upsert records (actor recorded), then recompute progress. */
slotRoutes.post("/lesson-slots/:id/attendance", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const deps = c.get("deps");
  const id = pathId(c);
  const input = await readBody(c, AttendanceInput);
  const stored = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const result = await recordAttendance(tx, actor, id, deps.now(), input.records);
      return { status: 200, body: { id, data: result, checked_at: deps.now().toISOString() } };
    }),
  );
  return respondStored(c, stored);
});

const TodayQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.string().optional() });

/** GET /today-lessons — organisation-timezone "today": teacher → own slots; student → approved reservations. */
slotRoutes.get("/today-lessons", requireRole("teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const deps = c.get("deps");
  const q = readQuery(c, TodayQuery);
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, KeyCursor);
  const today = zonedDateString(deps.now(), actor.timezone);
  const rows = await actorTx(c, (tx) => listTodayLessons(tx, actor, today, cursor, limit));
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ k: r.cursor_ts, id: r.id }));
  return page(
    c,
    items.map((r) => toSlotDto(r, actor)),
    nextCursor,
  );
});
