/**
 * Booking concurrency against the real PostgreSQL through the API (docs/07 scenario 5).
 * Requests run concurrently on the runtime-role pg pool; the database (slot row lock, unique/exclusion
 * constraints, idempotency key) is what guarantees the outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { createClassroom, createStudent, createTeacher } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { bookingWorld, createSlotViaApi, decide, insertSlot, nextWindow, reserve, slotBody, type BookingWorld } from "../helpers/booking-fixtures";

let ctx: TestContext;
let w: BookingWorld;

beforeAll(async () => {
  ctx = createTestContext();
  w = await bookingWorld(ctx);
});
afterAll(async () => ctx.close());

describe("last seat under 100 concurrent requests", () => {
  it("exactly one of 100 different students gets the last seat; 99 receive SLOT_FULL", async () => {
    const teacher = await createTeacher(ctx.admin, w.org.orgId, { displayName: "並行 講師" });
    const classroomId = await createClassroom(ctx.admin, w.org.orgId, { primaryTeacherId: teacher.userId, capacity: 150, name: "並行クラス" });
    const students: Caller[] = [];
    for (let i = 0; i < 100; i++) {
      const s = await createStudent(ctx.admin, w.org.orgId, { classroomId, teacherId: teacher.userId, displayName: `受講者${i}` });
      students.push(await bearerCaller(s.userId, w.org.orgId));
    }
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { classroomId, teacherId: teacher.userId, capacity: 1 }));

    const results = await Promise.all(students.map((s) => call(ctx, s, "POST", "/reservations", { body: { slot_id: slot.id } })));

    const created = results.filter((r) => r.status === 201);
    const full = results.filter((r) => r.status === 409 && r.body.code === "SLOT_FULL");
    expect(created).toHaveLength(1);
    expect(full).toHaveLength(99);
    expect(full[0]?.body.message_ja).toBe("この授業は満席です。");
    expectContract(created[0]!, "post", "/reservations");
    expectContract(full[0]!, "post", "/reservations");

    const { rows } = await ctx.admin.query(
      "SELECT count(*)::int AS n FROM app.reservations WHERE org_id = $1 AND slot_id = $2 AND status IN ('pending','approved')",
      [w.org.orgId, slot.id],
    );
    expect(rows[0].n).toBe(1);
    const audit = await ctx.admin.query("SELECT count(*)::int AS n FROM app.audit_events WHERE org_id = $1 AND event_type = 'reservation.created' AND payload->>'slot_id' = $2", [w.org.orgId, slot.id]);
    expect(audit.rows[0].n).toBe(1);

    const listed = await call(ctx, w.admin, "GET", `/lesson-slots/${slot.id}`);
    expect(listed.body.data.remaining).toBe(0);
  }, 120_000);
});

describe("double tap / resend with the same Idempotency-Key", () => {
  it("10 concurrent identical requests create one reservation and return identical responses", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 5 }));
    const key = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id }, idempotencyKey: key })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    // Replays return the stored response (same id, status, row_version, even the original checked_at).
    for (const r of results) expect(r.body).toEqual(results[0]!.body);
    expect(new Set(results.map((r) => r.body.checked_at)).size).toBe(1);
    const { rows } = await ctx.admin.query("SELECT count(*)::int AS n FROM app.reservations WHERE org_id = $1 AND slot_id = $2", [w.org.orgId, slot.id]);
    expect(rows[0].n).toBe(1);

    // A later resend (e.g. after reconnecting) still returns the same reservation.
    const again = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id }, idempotencyKey: key });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(results[0]!.body.id);
  });

  it("the same key for a different slot is 409 IDEMPOTENCY_CONFLICT and books nothing", async () => {
    const a = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const b = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const key = crypto.randomUUID();
    await reserve(ctx, w.student2, a.id, key);
    const res = await call(ctx, w.student2, "POST", "/reservations", { body: { slot_id: b.id }, idempotencyKey: key });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expectContract(res, "post", "/reservations");
    const { rows } = await ctx.admin.query("SELECT count(*)::int AS n FROM app.reservations WHERE org_id = $1 AND slot_id = $2", [w.org.orgId, b.id]);
    expect(rows[0].n).toBe(0);
  });

  it("the DB key also guards requests whose HTTP idempotency record expired (key reused for another slot)", async () => {
    const a = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const b = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const key = crypto.randomUUID();
    await reserve(ctx, w.student2, a.id, key);
    await ctx.admin.query("UPDATE app.idempotency_requests SET expires_at = now() - interval '1 minute' WHERE key = $1", [key]);
    const res = await call(ctx, w.student2, "POST", "/reservations", { body: { slot_id: b.id }, idempotencyKey: key });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("time overlap for the same student", () => {
  it("an overlapping active reservation on another slot is 409 TIME_CONFLICT (DB exclusion constraint)", async () => {
    // Two slots of one classroom can never overlap (classroom exclusion), so the overlapping hold comes from
    // a slot of another classroom (e.g. data carried over from the legacy system).
    const win = nextWindow({ daysAhead: 4 });
    const foreign = await insertSlot(ctx.admin, w.org.orgId, {
      classroomId: w.org.otherClassroomId,
      teacherId: w.org.otherTeacher.userId,
      startsAt: win.startsAt,
      endsAt: win.endsAt,
      closesAt: new Date(win.startsAt.getTime() - 3_600_000),
    });
    await ctx.admin.query(
      `INSERT INTO app.reservations(org_id, slot_id, student_id, starts_at, ends_at, status, expires_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'approved', $4, gen_random_uuid())`,
      [w.org.orgId, foreign, w.org.student.userId, win.startsAt, win.endsAt],
    );
    const overlapping = await createSlotViaApi(
      ctx,
      w.admin,
      slotBody(w.org, { startsAt: new Date(win.startsAt.getTime() + 30 * 60_000), endsAt: new Date(win.endsAt.getTime() + 30 * 60_000) }),
    );
    const res = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: overlapping.id } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TIME_CONFLICT");
    expect(res.body.message_ja).toBe("同じ時間に別の予約があります。");
    expectContract(res, "post", "/reservations");
  });

  it("an overlapping pending whose hold already lapsed is expired (and committed) first, so booking succeeds", async () => {
    const win = nextWindow({ daysAhead: 5 });
    const foreign = await insertSlot(ctx.admin, w.org.orgId, {
      classroomId: w.org.otherClassroomId,
      teacherId: w.org.otherTeacher.userId,
      startsAt: win.startsAt,
      endsAt: win.endsAt,
      closesAt: new Date(win.startsAt.getTime() - 3_600_000),
    });
    const stale = await ctx.admin.query(
      `INSERT INTO app.reservations(org_id, slot_id, student_id, starts_at, ends_at, status, expires_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', now() - interval '1 minute', gen_random_uuid()) RETURNING id`,
      [w.org.orgId, foreign, w.org.student2.userId, win.startsAt, win.endsAt],
    );
    const overlapping = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { startsAt: win.startsAt, endsAt: win.endsAt }));
    const res = await call(ctx, w.student2, "POST", "/reservations", { body: { slot_id: overlapping.id } });
    expect(res.status).toBe(201);
    const { rows } = await ctx.admin.query("SELECT status FROM app.reservations WHERE id = $1", [stale.rows[0].id]);
    expect(rows[0].status).toBe("expired");
    const audit = await ctx.admin.query("SELECT count(*)::int AS n FROM app.audit_events WHERE entity_id = $1 AND event_type = 'reservation.expired'", [stale.rows[0].id]);
    expect(audit.rows[0].n).toBe(1);
  });
});

describe("concurrent decisions on one reservation", () => {
  it("teacher approval and student cancellation with the same expected_version: exactly one wins", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    const [approve, cancel] = await Promise.all([
      decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version }),
      decide(ctx, w.student, r.id, "cancel", { expected_version: r.row_version }),
    ]);
    const statuses = [approve.status, cancel.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = approve.status === 409 ? approve : cancel;
    expect(loser.body.code).toBe("VERSION_CONFLICT");
    const { rows } = await ctx.admin.query("SELECT status, row_version FROM app.reservations WHERE id = $1", [r.id]);
    expect(["approved", "cancelled"]).toContain(rows[0].status);
    expect(rows[0].row_version).toBe(r.row_version + 1);
  });
});
