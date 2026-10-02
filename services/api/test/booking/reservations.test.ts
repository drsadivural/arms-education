/** Reservations: booking, scope, decisions, expiry and history (docs/04, docs/07 scenarios 3–6). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestContext, type TestContext } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { createTeacher } from "../helpers/fixtures";
import {
  auditTypes,
  bookingWorld,
  createSlotViaApi,
  decide,
  insertSlot,
  nextWindow,
  outboxRows,
  reserve,
  slotBody,
  type BookingWorld,
} from "../helpers/booking-fixtures";

let ctx: TestContext;
let w: BookingWorld;

beforeAll(async () => {
  ctx = createTestContext();
  w = await bookingWorld(ctx);
});
afterAll(async () => ctx.close());

describe("POST /reservations", () => {
  it("a student books a slot of their classroom: pending, seat held, audit + outbox", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 3 }));
    const res = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id } });
    expect(res.status).toBe(201);
    expectContract(res, "post", "/reservations");
    expect(res.body.status).toBe("pending");
    expect(res.body.slot_title).toBe("IT基礎");
    expect(res.body.student_name).toBe("和田 一夫");
    expect(res.body.meeting_url).toBeNull();
    // Hold = min(request + 24h, lesson start).
    const held = new Date(res.body.expires_at).getTime() - Date.now();
    expect(held).toBeGreaterThan(23 * 3_600_000);
    expect(held).toBeLessThanOrEqual(24 * 3_600_000 + 5_000);
    expect(new Date(res.body.cancel_deadline).getTime()).toBe(new Date(slot.starts_at).getTime() - 86_400_000);

    expect(await auditTypes(ctx.admin, w.org.orgId, res.body.id)).toEqual(["reservation.created"]);
    expect((await outboxRows(ctx.admin, w.org.orgId, res.body.id)).map((o) => o.event_type)).toEqual(["reservation.created"]);

    const slotNow = await call(ctx, w.student, "GET", `/lesson-slots/${slot.id}`);
    expect(slotNow.body.data.remaining).toBe(2);
    expect(slotNow.body.data.my_reservation).toEqual({ id: res.body.id, status: "pending" });
  });

  it("requires authentication, the student role and an Idempotency-Key", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    expect((await call(ctx, null, "POST", "/reservations", { body: { slot_id: slot.id } })).status).toBe(401);
    const teacher = await call(ctx, w.teacher, "POST", "/reservations", { body: { slot_id: slot.id } });
    expect(teacher.status).toBe(403);
    expectContract(teacher, "post", "/reservations");
    expect((await call(ctx, w.admin, "POST", "/reservations", { body: { slot_id: slot.id } })).status).toBe(403);
    const noKey = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id }, idempotencyKey: false });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("validates the body with Japanese field errors", async () => {
    const res = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: "not-a-uuid", extra: 1 } });
    expect(res.status).toBe(422);
    expectContract(res, "post", "/reservations");
    expect(res.body.field_errors.slot_id).toBe("選択肢から選んでください。");
    expect(res.body.field_errors._).toContain("許可されていない項目");
  });

  it("a slot of another classroom is 403; an unknown slot is 404", async () => {
    const other = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { classroomId: w.org.otherClassroomId, teacherId: w.org.otherTeacher.userId }));
    const res = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: other.id } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    const missing = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: crypto.randomUUID() } });
    expect(missing.status).toBe(404);
  });

  it("a second active request for the same slot is 409 ALREADY_RESERVED", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    await reserve(ctx, w.student, slot.id);
    const res = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_RESERVED");
    expect(res.body.message_ja).toBe("この授業は既に申請済みです。");
  });

  it("booking after booking_closes_at is 409 BOOKING_CLOSED; a closed slot too", async () => {
    const win = nextWindow();
    const closed = await insertSlot(ctx.admin, w.org.orgId, {
      classroomId: w.org.classroomId,
      teacherId: w.org.teacher.userId,
      startsAt: win.startsAt,
      endsAt: win.endsAt,
      closesAt: new Date(Date.now() - 60_000),
    });
    const res = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: closed } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_CLOSED");
    expect(res.body.message_ja).toBe("予約受付を終了しました。");
  });
});

describe("booking preconditions beyond capacity", () => {
  it("slots of a disabled teacher are not offered and refuse bookings (BOOKING_CLOSED)", async () => {
    const extra = await createTeacher(ctx.admin, w.org.orgId, { displayName: "退職予定 講師" });
    await ctx.admin.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, false)", [w.org.orgId, w.org.classroomId, extra.userId]);
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { teacherId: extra.userId }));
    await ctx.admin.query("UPDATE app.memberships SET active = false WHERE org_id = $1 AND id = $2", [w.org.orgId, extra.userId]);
    const listed = await call(ctx, w.student, "GET", "/lesson-slots?limit=100");
    expect(listed.body.items.map((s: { id: string }) => s.id)).not.toContain(slot.id);
    const res = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_CLOSED");
    // Creating new slots for a disabled teacher is refused too, but the admin can still close the existing one.
    const create = await call(ctx, w.admin, "POST", "/lesson-slots", { body: slotBody(w.org, { teacherId: extra.userId }) });
    expect(create.status).toBe(422);
    expect(create.body.code).toBe("TEACHER_INACTIVE");
    const close = await call(ctx, w.admin, "PATCH", `/lesson-slots/${slot.id}`, {
      body: { ...slotBody(w.org, { teacherId: extra.userId, startsAt: new Date(slot.starts_at) }), state: "closed" },
      ifMatch: slot.row_version,
    });
    expect(close.status).toBe(200);
    expect(close.body.data.state).toBe("closed");
  });

  it("a lesson tied to a unit needs the unit's programme assigned to the student or their classroom", async () => {
    const program = await ctx.admin.query("INSERT INTO app.programs(org_id, name) VALUES ($1, '新入社員基礎研修') RETURNING id", [w.org.orgId]);
    const version = await ctx.admin.query("INSERT INTO app.program_versions(org_id, program_id, version_number, state) VALUES ($1, $2, 1, 'draft') RETURNING id", [
      w.org.orgId,
      program.rows[0].id,
    ]);
    const unit = await ctx.admin.query("INSERT INTO app.units(org_id, program_version_id, title, position, weight) VALUES ($1, $2, 'IT基礎', 0, 1) RETURNING id", [
      w.org.orgId,
      version.rows[0].id,
    ]);
    const unitId = unit.rows[0].id as string;
    const unlinked = await call(ctx, w.admin, "POST", "/lesson-slots", { body: { ...slotBody(w.org), unit_id: unitId } });
    expect(unlinked.status).toBe(422);
    expect(unlinked.body.field_errors.unit_id).toBe("このクラスの教育プログラムに含まれない単元です。");

    await ctx.admin.query("INSERT INTO app.classroom_programs(org_id, classroom_id, program_version_id) VALUES ($1, $2, $3)", [w.org.orgId, w.org.classroomId, version.rows[0].id]);
    const slot = await createSlotViaApi(ctx, w.admin, { ...slotBody(w.org), unit_id: unitId });
    // The classroom later drops the programme: only students enrolled in it may still book.
    await ctx.admin.query("DELETE FROM app.classroom_programs WHERE org_id = $1 AND classroom_id = $2", [w.org.orgId, w.org.classroomId]);
    const refused = await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id } });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("PROGRAM_NOT_ASSIGNED");
    expect(refused.body.message_ja).toContain("教育プログラム");
    await ctx.admin.query("INSERT INTO app.enrollments(org_id, student_id, program_version_id, due_on) VALUES ($1, $2, $3, '2026-12-31')", [
      w.org.orgId,
      w.org.student.userId,
      version.rows[0].id,
    ]);
    expect((await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id } })).status).toBe(201);
  });
});

describe("GET /reservations and /reservations/{id} scope", () => {
  it("student: own; teacher: own slots; admin: all; others 404", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const mine = await reserve(ctx, w.student2, slot.id);

    const own = await call(ctx, w.student2, "GET", `/reservations?slot_id=${slot.id}`);
    expect(own.status).toBe(200);
    expectContract(own, "get", "/reservations");
    expect(own.body.items.map((r: { id: string }) => r.id)).toEqual([mine.id]);

    const otherStudent = await call(ctx, w.student, "GET", `/reservations?slot_id=${slot.id}`);
    expect(otherStudent.body.items).toEqual([]);
    expect((await call(ctx, w.student, "GET", `/reservations/${mine.id}`)).status).toBe(404);

    const teacher = await call(ctx, w.teacher, "GET", `/reservations?slot_id=${slot.id}`);
    expect(teacher.body.items).toHaveLength(1);
    const otherTeacher = await call(ctx, w.otherTeacher, "GET", `/reservations?slot_id=${slot.id}`);
    expect(otherTeacher.body.items).toEqual([]);
    const otherTeacherDetail = await call(ctx, w.otherTeacher, "GET", `/reservations/${mine.id}`);
    expect(otherTeacherDetail.status).toBe(404);
    expectContract(otherTeacherDetail, "get", "/reservations/{id}");

    const admin = await call(ctx, w.admin, "GET", `/reservations/${mine.id}`);
    expect(admin.status).toBe(200);
    expectContract(admin, "get", "/reservations/{id}");
    expect(admin.headers.get("etag")).toBe(`"${mine.row_version}"`);
    expect(admin.body.history.map((h: { event_type: string }) => h.event_type)).toEqual(["reservation.created"]);
    expect(admin.body.history[0].actor_name).toBe("高橋 健太");

    expect((await call(ctx, null, "GET", "/reservations")).status).toBe(401);
  });

  it("filters: status list, q (name / employee number), JST dates, idempotency_key, sort and cursor", async () => {
    const a = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const b = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const key = crypto.randomUUID();
    const ra = await reserve(ctx, w.student, a.id, key);
    const rb = await reserve(ctx, w.student, b.id);

    const byKey = await call(ctx, w.student, "GET", `/reservations?idempotency_key=${key}`);
    expect(byKey.body.items.map((r: { id: string }) => r.id)).toEqual([ra.id]);
    // The key lookup only matches the caller's own requests.
    expect((await call(ctx, w.student2, "GET", `/reservations?idempotency_key=${key}`)).body.items).toEqual([]);

    const byName = await call(ctx, w.admin, "GET", `/reservations?q=${encodeURIComponent("和田")}&slot_id=${a.id}`);
    expect(byName.body.items.map((r: { id: string }) => r.id)).toEqual([ra.id]);
    expect((await call(ctx, w.admin, "GET", `/reservations?q=${encodeURIComponent("存在しない%")}&slot_id=${a.id}`)).body.items).toEqual([]);

    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(a.starts_at));
    const byDay = await call(ctx, w.student, "GET", `/reservations?from=${day}&to=${day}`);
    expect(byDay.body.items.map((r: { id: string }) => r.id)).toContain(ra.id);

    const pending = await call(ctx, w.student, "GET", "/reservations?status=pending,approved&limit=1");
    expect(pending.status).toBe(200);
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.next_cursor).toBeTruthy();
    const second = await call(ctx, w.student, "GET", `/reservations?status=pending,approved&limit=1&cursor=${pending.body.next_cursor}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(pending.body.items[0].id);

    const desc = await call(ctx, w.student, "GET", `/reservations?sort=-starts_at&slot_id=${b.id}`);
    expect(desc.body.items[0].id).toBe(rb.id);
    const mismatch = await call(ctx, w.student, "GET", `/reservations?sort=-created_at&cursor=${pending.body.next_cursor}`);
    expect(mismatch.status).toBe(422);

    const bad = await call(ctx, w.student, "GET", "/reservations?status=pending,unknown");
    expect(bad.status).toBe(422);
    expectContract(bad, "get", "/reservations");
    expect(bad.body.field_errors.status).toContain("pending");
    expect((await call(ctx, w.student, "GET", "/reservations?from=2026-02-30")).status).toBe(422);
  });
});

describe("decisions", () => {
  it("teacher approves: approved, meeting URL disclosed to the student, audit + outbox; replay with the same key", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { meetingUrl: "https://meet.example.invalid/approved" }));
    const r = await reserve(ctx, w.student, slot.id);
    const key = crypto.randomUUID();
    const res = await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version }, key);
    expect(res.status).toBe(200);
    expectContract(res, "post", "/reservations/{id}/approve");
    expect(res.body.status).toBe("approved");
    expect(res.body.row_version).toBe(r.row_version + 1);

    const replay = await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version }, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(res.body);

    const studentView = await call(ctx, w.student, "GET", `/reservations/${r.id}`);
    expect(studentView.body.meeting_url).toBe("https://meet.example.invalid/approved");
    const slotView = await call(ctx, w.student, "GET", `/lesson-slots/${slot.id}`);
    expect(slotView.body.data.meeting_url).toBe("https://meet.example.invalid/approved");
    expect(await auditTypes(ctx.admin, w.org.orgId, r.id)).toEqual(["reservation.created", "reservation.approved"]);
    expect((await outboxRows(ctx.admin, w.org.orgId, r.id)).map((o) => o.event_type)).toEqual(["reservation.created", "reservation.approved"]);
  });

  it("stale expected_version is 409 VERSION_CONFLICT with the current state", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    const res = await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version + 5 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
    expect(res.body.details).toEqual({ status: "pending", row_version: r.row_version });
    expectContract(res, "post", "/reservations/{id}/approve");
  });

  it("role and scope: student cannot approve (403); another teacher's slot is 404; another student cannot cancel (404)", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    expect((await decide(ctx, w.student, r.id, "approve", { expected_version: r.row_version })).status).toBe(403);
    const other = await decide(ctx, w.otherTeacher, r.id, "approve", { expected_version: r.row_version });
    expect(other.status).toBe(404);
    expect((await decide(ctx, w.student2, r.id, "cancel", { expected_version: r.row_version })).status).toBe(404);
    expect((await decide(ctx, w.teacher, r.id, "cancel", { expected_version: r.row_version })).status).toBe(403);
    expect((await decide(ctx, null as never, r.id, "approve", { expected_version: r.row_version })).status).toBe(401);
    const { rows } = await ctx.admin.query("SELECT status FROM app.reservations WHERE id = $1", [r.id]);
    expect(rows[0].status).toBe("pending");
  });

  it("reject requires a reason (422 REASON_REQUIRED); the student sees the reason", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    const missing = await decide(ctx, w.teacher, r.id, "reject", { expected_version: r.row_version, reason: "   " });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe("REASON_REQUIRED");
    expectContract(missing, "post", "/reservations/{id}/reject");
    const tooLong = await decide(ctx, w.teacher, r.id, "reject", { expected_version: r.row_version, reason: "あ".repeat(1001) });
    expect(tooLong.status).toBe(422);
    const ok = await decide(ctx, w.admin, r.id, "reject", { expected_version: r.row_version, reason: "定員調整のため" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("rejected");
    const mine = await call(ctx, w.student, "GET", `/reservations/${r.id}`);
    expect(mine.body.reason).toBe("定員調整のため");
    expect(mine.body.history.at(-1)).toMatchObject({ event_type: "reservation.rejected", status: "rejected", reason: "定員調整のため" });
    // A rejected request cannot be approved any more.
    const late = await decide(ctx, w.teacher, r.id, "approve", { expected_version: ok.body.row_version });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("INVALID_STATE");
  });

  it("student cancellation restores the seat; after the cancel deadline it is 409 CANCELLATION_CLOSED", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 1 }));
    const r = await reserve(ctx, w.student, slot.id);
    expect((await call(ctx, w.student2, "POST", "/reservations", { body: { slot_id: slot.id } })).body.code).toBe("SLOT_FULL");
    const cancelled = await decide(ctx, w.student, r.id, "cancel", { expected_version: r.row_version });
    expect(cancelled.status).toBe(200);
    expectContract(cancelled, "post", "/reservations/{id}/cancel");
    expect(cancelled.body.status).toBe("cancelled");
    expect((await call(ctx, w.admin, "GET", `/lesson-slots/${slot.id}`)).body.data.remaining).toBe(1);
    expect((await call(ctx, w.student2, "POST", "/reservations", { body: { slot_id: slot.id } })).status).toBe(201);

    // Lesson in 2 hours with the default 24h cancellation deadline.
    const soon = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { startsAt: new Date(Date.now() + 2 * 3_600_000 + 7 * 60_000) }));
    const r2 = await reserve(ctx, w.student, soon.id);
    const late = await decide(ctx, w.student, r2.id, "cancel", { expected_version: r2.row_version });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("CANCELLATION_CLOSED");
    expect(late.body.message_ja).toBe("取消期限を過ぎているため取消できません。");
  });

  it("remove is a soft delete with a reason: hidden from lists, history kept", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    const noReason = await decide(ctx, w.teacher, r.id, "remove", { expected_version: r.row_version });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe("REASON_REQUIRED");
    const removed = await decide(ctx, w.teacher, r.id, "remove", { expected_version: r.row_version, reason: "重複申請のため" });
    expect(removed.status).toBe(200);
    expectContract(removed, "post", "/reservations/{id}/remove");
    expect(removed.body.status).toBe("removed");

    const list = await call(ctx, w.admin, "GET", `/reservations?slot_id=${slot.id}`);
    expect(list.body.items).toEqual([]);
    const explicit = await call(ctx, w.admin, "GET", `/reservations?slot_id=${slot.id}&status=removed`);
    expect(explicit.body.items.map((x: { id: string }) => x.id)).toEqual([r.id]);
    const detail = await call(ctx, w.admin, "GET", `/reservations/${r.id}`);
    expect(detail.body.history.map((h: { event_type: string }) => h.event_type)).toEqual(["reservation.created", "reservation.removed"]);
    const { rows } = await ctx.admin.query("SELECT count(*)::int AS n FROM app.reservations WHERE id = $1", [r.id]);
    expect(rows[0].n).toBe(1);
    // The seat is released.
    expect((await call(ctx, w.admin, "GET", `/lesson-slots/${slot.id}`)).body.data.remaining).toBe(5);
  });

  it("approval after the lesson started is 409 INVALID_STATE", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { title: "開始済み" }));
    const r = await reserve(ctx, w.student2, slot.id);
    // Simulate time passing: the lesson started a minute ago while the request is still held. (The
    // active-reservation guard forbids moving a slot with active reservations, so park the row first.)
    await ctx.admin.query("UPDATE app.reservations SET status = 'rejected' WHERE id = $1", [r.id]);
    await ctx.admin.query(
      "UPDATE app.lesson_slots SET starts_at = now() - interval '1 minute', ends_at = now() + interval '1 hour', booking_closes_at = now() - interval '2 minutes' WHERE id = $1",
      [slot.id],
    );
    await ctx.admin.query("UPDATE app.reservations SET status = 'pending', expires_at = now() + interval '1 hour' WHERE id = $1", [r.id]);
    const res = await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATE");
  });
});

describe("pending expiry (docs/07 scenario 6)", () => {
  it("approving a lapsed pending is 409 RESERVATION_EXPIRED; the expiry is committed with audit + outbox and the seat is released", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 1 }));
    const r = await reserve(ctx, w.student, slot.id);
    // SQL now() cannot be mocked: move the hold into the past instead.
    await ctx.admin.query("UPDATE app.reservations SET expires_at = now() - interval '1 minute' WHERE id = $1", [r.id]);

    // Readers already see it as expired and the seat as free.
    const listed = await call(ctx, w.teacher, "GET", `/reservations?slot_id=${slot.id}`);
    expect(listed.body.items[0].status).toBe("expired");
    expect((await call(ctx, w.teacher, "GET", `/lesson-slots/${slot.id}`)).body.data.remaining).toBe(1);

    const res = await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version });
    expect(res.status).toBe(409);
    expectContract(res, "post", "/reservations/{id}/approve");
    expect(res.body.code).toBe("RESERVATION_EXPIRED");
    expect(res.body.details).toEqual({ status: "expired", row_version: r.row_version + 1 });

    const { rows } = await ctx.admin.query("SELECT status FROM app.reservations WHERE id = $1", [r.id]);
    expect(rows[0].status).toBe("expired");
    expect(await auditTypes(ctx.admin, w.org.orgId, r.id)).toEqual(["reservation.created", "reservation.expired"]);
    const outbox = await outboxRows(ctx.admin, w.org.orgId, r.id);
    expect(outbox.map((o) => o.event_type)).toEqual(["reservation.created", "reservation.expired"]);

    // The seat is free for someone else, and later decisions keep answering RESERVATION_EXPIRED.
    expect((await call(ctx, w.student2, "POST", "/reservations", { body: { slot_id: slot.id } })).status).toBe(201);
    const again = await decide(ctx, w.teacher, r.id, "reject", { expected_version: r.row_version + 1, reason: "期限切れ" });
    expect(again.body.code).toBe("RESERVATION_EXPIRED");
    const cancel = await decide(ctx, w.student, r.id, "cancel", { expected_version: r.row_version + 1 });
    expect(cancel.body.code).toBe("RESERVATION_EXPIRED");
    // An expired request can still be removed (soft delete).
    const removed = await decide(ctx, w.admin, r.id, "remove", { expected_version: r.row_version + 1, reason: "整理のため" });
    expect(removed.status).toBe(200);
    expect(removed.body.status).toBe("removed");
  });
});
