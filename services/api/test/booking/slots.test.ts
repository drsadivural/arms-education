/** Lesson slots, slot cancellation, today's lessons and attendance (WEB-15, IOS-07, IOS-11, IOS-16). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zonedDateString } from "@arms/contracts";
import { bearerCaller, call, createTestContext, type TestContext } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { createOrg, createUser } from "../helpers/fixtures";
import { auditTypes, bookingWorld, createSlotViaApi, decide, outboxRows, reserve, slotBody, type BookingWorld } from "../helpers/booking-fixtures";

let ctx: TestContext;
let w: BookingWorld;

beforeAll(async () => {
  ctx = createTestContext();
  // Organisation booking settings override the deployment defaults for new slots.
  w = await bookingWorld(ctx, { booking_cancel_before_seconds: 7200, booking_pending_ttl_seconds: 3600 });
});
afterAll(async () => ctx.close());

describe("POST /lesson-slots", () => {
  it("admin creates a slot; defaults come from organisation settings; audited", async () => {
    const res = await call(ctx, w.admin, "POST", "/lesson-slots", { body: slotBody(w.org, { capacity: 4 }) });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/lesson-slots");
    const slot = res.body.data;
    expect(slot).toMatchObject({ capacity: 4, remaining: 4, state: "open", cancel_before_seconds: 7200, has_meeting_url: true, teacher_name: "田中 祥司" });
    expect(slot.meeting_url).toBe("https://meet.example.invalid/room-1");
    expect(res.headers.get("etag")).toBe(`"${slot.row_version}"`);
    const { rows } = await ctx.admin.query("SELECT pending_ttl_seconds FROM app.lesson_slots WHERE id = $1", [slot.id]);
    expect(rows[0].pending_ttl_seconds).toBe(3600);
    expect(await auditTypes(ctx.admin, w.org.orgId, slot.id)).toEqual(["lesson_slot.created"]);
    const audit = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE entity_id = $1", [slot.id]);
    expect(JSON.stringify(audit.rows[0].payload)).not.toContain("meet.example.invalid");
  });

  it("teacher may create only their own slots in classrooms they teach", async () => {
    const own = await call(ctx, w.teacher, "POST", "/lesson-slots", { body: slotBody(w.org, { meetingUrl: null }) });
    expect(own.status).toBe(200);
    expect(own.body.data.has_meeting_url).toBe(false);
    const forOther = await call(ctx, w.teacher, "POST", "/lesson-slots", { body: slotBody(w.org, { teacherId: w.org.otherTeacher.userId, classroomId: w.org.otherClassroomId }) });
    expect(forOther.status).toBe(403);
    expectContract(forOther, "post", "/lesson-slots");
    const notAssigned = await call(ctx, w.teacher, "POST", "/lesson-slots", { body: slotBody(w.org, { classroomId: w.org.otherClassroomId }) });
    expect(notAssigned.status).toBe(422);
    expect(notAssigned.body.code).toBe("TEACHER_CLASSROOM_MISMATCH");
    expect(notAssigned.body.field_errors.teacher_id).toContain("担当");
    expect((await call(ctx, w.student, "POST", "/lesson-slots", { body: slotBody(w.org) })).status).toBe(403);
    expect((await call(ctx, null, "POST", "/lesson-slots", { body: slotBody(w.org) })).status).toBe(401);
  });

  it("validates times, URL and required fields with Japanese messages", async () => {
    const base = slotBody(w.org);
    const closesAfterStart = await call(ctx, w.admin, "POST", "/lesson-slots", {
      body: { ...base, booking_closes_at: new Date(new Date(base.starts_at as string).getTime() + 60_000).toISOString() },
    });
    expect(closesAfterStart.status).toBe(422);
    expectContract(closesAfterStart, "post", "/lesson-slots");
    expect(closesAfterStart.body.field_errors.booking_closes_at).toBe("予約締切は授業開始時刻以前にしてください。");
    const http = await call(ctx, w.admin, "POST", "/lesson-slots", { body: { ...base, meeting_url: "http://insecure.example.invalid/" } });
    expect(http.body.field_errors.meeting_url).toBe("https:// から始まるURLを入力してください。");
    const missing = await call(ctx, w.admin, "POST", "/lesson-slots", { body: { ...base, title: "" } });
    expect(missing.body.field_errors.title).toBe("必須項目です。");
    const past = await call(ctx, w.admin, "POST", "/lesson-slots", {
      body: { ...base, starts_at: new Date(Date.now() - 3_600_000).toISOString(), ends_at: new Date(Date.now() - 60_000).toISOString(), booking_closes_at: new Date(Date.now() - 7_200_000).toISOString() },
    });
    expect(past.status).toBe(422);
    expect(past.body.field_errors.starts_at).toBe("開始時刻は現在より後にしてください。");
    const unknownUnit = await call(ctx, w.admin, "POST", "/lesson-slots", { body: { ...base, unit_id: crypto.randomUUID() } });
    expect(unknownUnit.body.field_errors.unit_id).toBe("単元が見つかりません。");
  });

  it("overlapping slots of the same teacher or classroom are 409 SLOT_TIME_CONFLICT", async () => {
    const body = slotBody(w.org);
    await createSlotViaApi(ctx, w.admin, body);
    const res = await call(ctx, w.admin, "POST", "/lesson-slots", { body: { ...body, title: "重複" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_TIME_CONFLICT");
    expectContract(res, "post", "/lesson-slots");
  });
});

describe("GET /lesson-slots scope, remaining and meeting URL", () => {
  it("students see only their classroom's open upcoming slots without the private URL", async () => {
    const mine = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { title: "自クラス枠", capacity: 2 }));
    const other = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { title: "他クラス枠", classroomId: w.org.otherClassroomId, teacherId: w.org.otherTeacher.userId }));

    const res = await call(ctx, w.student, "GET", "/lesson-slots?limit=100");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/lesson-slots");
    const ids = res.body.items.map((s: { id: string }) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
    const item = res.body.items.find((s: { id: string }) => s.id === mine.id);
    expect(item.meeting_url).toBeNull();
    expect(item.has_meeting_url).toBe(true);
    expect(item.my_reservation).toBeNull();
    expect(item.pending_count).toBeUndefined();

    expect((await call(ctx, w.otherStudent, "GET", `/lesson-slots/${mine.id}`)).status).toBe(404);
    expect((await call(ctx, w.otherTeacher, "GET", `/lesson-slots/${mine.id}`)).status).toBe(404);
    const teacherView = await call(ctx, w.teacher, "GET", `/lesson-slots/${mine.id}`);
    expect(teacherView.status).toBe(200);
    expectContract(teacherView, "get", "/lesson-slots/{id}");
    expect(teacherView.body.data.meeting_url).toBe("https://meet.example.invalid/room-1");
    const adminList = await call(ctx, w.admin, "GET", "/lesson-slots?limit=100");
    expect(adminList.body.items.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([mine.id, other.id]));
    expect((await call(ctx, null, "GET", "/lesson-slots")).status).toBe(401);
  });

  it("remaining counts live pending + approved at read time; the URL appears only after approval", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 2 }));
    const r1 = await reserve(ctx, w.student, slot.id);
    await reserve(ctx, w.student2, slot.id);
    let view = await call(ctx, w.admin, "GET", `/lesson-slots/${slot.id}`);
    expect(view.body.data).toMatchObject({ remaining: 0, pending_count: 2, approved_count: 0 });
    const pendingView = await call(ctx, w.student, "GET", `/lesson-slots/${slot.id}`);
    expect(pendingView.body.data.meeting_url).toBeNull();

    await decide(ctx, w.teacher, r1.id, "approve", { expected_version: r1.row_version });
    view = await call(ctx, w.admin, "GET", `/lesson-slots/${slot.id}`);
    expect(view.body.data).toMatchObject({ remaining: 0, pending_count: 1, approved_count: 1 });
    const approvedView = await call(ctx, w.student, "GET", `/lesson-slots/${slot.id}`);
    expect(approvedView.body.data.meeting_url).toBe("https://meet.example.invalid/room-1");
    expect(approvedView.body.data.my_reservation).toEqual({ id: r1.id, status: "approved" });
    const otherPending = await call(ctx, w.student2, "GET", `/lesson-slots/${slot.id}`);
    expect(otherPending.body.data.meeting_url).toBeNull();
  });

  it("a co-teacher of the classroom sees the slot but not another teacher's private URL", async () => {
    await ctx.admin.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING", [
      w.org.orgId,
      w.org.classroomId,
      w.org.otherTeacher.userId,
    ]);
    try {
      const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
      const res = await call(ctx, w.otherTeacher, "GET", `/lesson-slots/${slot.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.meeting_url).toBeNull();
      expect(res.body.data.has_meeting_url).toBe(true);
      // ...and cannot edit or cancel it.
      const patch = await call(ctx, w.otherTeacher, "PATCH", `/lesson-slots/${slot.id}`, { body: slotBody(w.org, { teacherId: w.org.otherTeacher.userId }), ifMatch: slot.row_version });
      expect(patch.status).toBe(403);
      const cancel = await call(ctx, w.otherTeacher, "POST", `/lesson-slots/${slot.id}/cancel`, { body: { reason: "x", expected_version: slot.row_version } });
      expect(cancel.status).toBe(403);
    } finally {
      await ctx.admin.query("DELETE FROM app.classroom_teachers WHERE org_id = $1 AND classroom_id = $2 AND teacher_id = $3", [w.org.orgId, w.org.classroomId, w.org.otherTeacher.userId]);
    }
  });

  it("filters by JST date range, state and title; paginates with a cursor; rejects bad filters", async () => {
    const a = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { title: "検索用A" }));
    const day = zonedDateString(new Date(a.starts_at), "Asia/Tokyo");
    const res = await call(ctx, w.admin, "GET", `/lesson-slots?from=${day}&to=${day}&q=${encodeURIComponent("検索用")}`);
    expect(res.body.items.map((s: { id: string }) => s.id)).toEqual([a.id]);

    const page1 = await call(ctx, w.admin, "GET", "/lesson-slots?limit=1");
    expect(page1.body.items).toHaveLength(1);
    const page2 = await call(ctx, w.admin, "GET", `/lesson-slots?limit=1&cursor=${page1.body.next_cursor}`);
    expect(page2.body.items).toHaveLength(1);
    expect(new Date(page2.body.items[0].starts_at).getTime()).toBeGreaterThanOrEqual(new Date(page1.body.items[0].starts_at).getTime());
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);

    const bad = await call(ctx, w.admin, "GET", "/lesson-slots?status=bogus");
    expect(bad.status).toBe(422);
    expectContract(bad, "get", "/lesson-slots");
    expect((await call(ctx, w.admin, "GET", "/lesson-slots?from=2026-10-10&to=2026-10-01")).status).toBe(422);
    expect((await call(ctx, w.admin, "GET", "/lesson-slots?cursor=@@@")).status).toBe(400);
    expect((await call(ctx, w.admin, "GET", "/lesson-slots?limit=500")).status).toBe(422);
  });
});

describe("PATCH /lesson-slots/{id}", () => {
  it("requires If-Match and the current version", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const body = slotBody(w.org, { title: "改題" });
    const noMatch = await call(ctx, w.admin, "PATCH", `/lesson-slots/${slot.id}`, { body });
    expect(noMatch.status).toBe(400);
    expect(noMatch.body.code).toBe("IF_MATCH_REQUIRED");
    const stale = await call(ctx, w.admin, "PATCH", `/lesson-slots/${slot.id}`, { body, ifMatch: slot.row_version + 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const ok = await call(ctx, w.admin, "PATCH", `/lesson-slots/${slot.id}`, { body, ifMatch: slot.row_version });
    expect(ok.status).toBe(200);
    expectContract(ok, "patch", "/lesson-slots/{id}");
    expect(ok.body.data.title).toBe("改題");
    expect(ok.body.data.row_version).toBe(slot.row_version + 1);
    expect(await auditTypes(ctx.admin, w.org.orgId, slot.id)).toEqual(["lesson_slot.created", "lesson_slot.updated"]);
  });

  it("with active reservations: title/URL/capacity increase allowed; time, teacher or capacity decrease → 409 ACTIVE_RESERVATIONS", async () => {
    const body = slotBody(w.org, { capacity: 3 });
    const slot = await createSlotViaApi(ctx, w.admin, body);
    await reserve(ctx, w.student, slot.id);
    let version = slot.row_version;

    const retitled = await call(ctx, w.admin, "PATCH", `/lesson-slots/${slot.id}`, { body: { ...body, title: "名称変更", capacity: 4, meeting_url: "https://meet.example.invalid/new" }, ifMatch: version });
    expect(retitled.status).toBe(200);
    version = retitled.body.data.row_version;

    const moved = await call(ctx, w.admin, "PATCH", `/lesson-slots/${slot.id}`, {
      body: { ...body, starts_at: new Date(new Date(body.starts_at as string).getTime() + 30 * 60_000).toISOString() },
      ifMatch: version,
    });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe("ACTIVE_RESERVATIONS");
    expect(moved.body.message_ja).toContain("有効な予約");
    expectContract(moved, "patch", "/lesson-slots/{id}");
    const shrunk = await call(ctx, w.admin, "PATCH", `/lesson-slots/${slot.id}`, { body: { ...body, capacity: 2 }, ifMatch: version });
    expect(shrunk.body.code).toBe("ACTIVE_RESERVATIONS");
    const { rows } = await ctx.admin.query("SELECT starts_at, capacity FROM app.lesson_slots WHERE id = $1", [slot.id]);
    expect(rows[0].capacity).toBe(4);
    expect(new Date(rows[0].starts_at).toISOString()).toBe(body.starts_at);
  });

  it("a teacher edits only their own slots; out-of-scope is 404", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const res = await call(ctx, w.otherTeacher, "PATCH", `/lesson-slots/${slot.id}`, { body: slotBody(w.org), ifMatch: slot.row_version });
    expect(res.status).toBe(404);
    const own = await call(ctx, w.teacher, "PATCH", `/lesson-slots/${slot.id}`, { body: { ...slotBody(w.org), state: "closed" }, ifMatch: slot.row_version });
    expect(own.status).toBe(200);
    expect(own.body.data.state).toBe("closed");
    // A closed slot is not offered to students and does not accept bookings.
    expect((await call(ctx, w.student, "GET", "/lesson-slots?limit=100")).body.items.map((s: { id: string }) => s.id)).not.toContain(slot.id);
    expect((await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id } })).body.code).toBe("BOOKING_CLOSED");
  });
});

describe("POST /lesson-slots/{id}/cancel", () => {
  it("cancels the slot and its active reservations with the reason, audited and queued for notification", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 3 }));
    const r1 = await reserve(ctx, w.student, slot.id);
    const r2 = await reserve(ctx, w.student2, slot.id);
    await decide(ctx, w.teacher, r1.id, "approve", { expected_version: r1.row_version });

    const noReason = await call(ctx, w.admin, "POST", `/lesson-slots/${slot.id}/cancel`, { body: { reason: "", expected_version: slot.row_version } });
    expect(noReason.status).toBe(422);
    expect(noReason.body.field_errors.reason).toBe("理由を入力してください。");
    const stale = await call(ctx, w.admin, "POST", `/lesson-slots/${slot.id}/cancel`, { body: { reason: "講師急病", expected_version: slot.row_version + 9 } });
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expect((await call(ctx, w.student, "POST", `/lesson-slots/${slot.id}/cancel`, { body: { reason: "x", expected_version: slot.row_version } })).status).toBe(403);

    const res = await call(ctx, w.admin, "POST", `/lesson-slots/${slot.id}/cancel`, { body: { reason: "講師急病のため", expected_version: slot.row_version } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/lesson-slots/{id}/cancel");
    expect(res.body.data).toMatchObject({ id: slot.id, state: "cancelled", cancelled_reservations: 2 });

    const { rows } = await ctx.admin.query("SELECT id, status, reason FROM app.reservations WHERE slot_id = $1 ORDER BY id", [slot.id]);
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(rows.every((r) => r.reason === "講師急病のため")).toBe(true);
    for (const id of [r1.id, r2.id]) {
      const outbox = await outboxRows(ctx.admin, w.org.orgId, id);
      expect(outbox.at(-1)).toMatchObject({ event_type: "reservation.cancelled", payload: { source: "slot_cancel", reason: "講師急病のため" } });
    }
    expect(await auditTypes(ctx.admin, w.org.orgId, slot.id)).toEqual(["lesson_slot.created", "lesson_slot.cancelled"]);

    const again = await call(ctx, w.admin, "POST", `/lesson-slots/${slot.id}/cancel`, { body: { reason: "再実行", expected_version: res.body.data.row_version } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SLOT_CANCELLED");
    // The time is free again: a replacement slot can be created in the same window (docs/04).
    const replacement = await call(ctx, w.admin, "POST", "/lesson-slots", { body: slotBody(w.org, { startsAt: new Date(slot.starts_at), title: "振替授業" }) });
    expect(replacement.status).toBe(200);
    expect((await call(ctx, w.student, "POST", "/reservations", { body: { slot_id: slot.id } })).body.code).toBe("BOOKING_CLOSED");
    const edit = await call(ctx, w.admin, "PATCH", `/lesson-slots/${slot.id}`, { body: slotBody(w.org), ifMatch: res.body.data.row_version });
    expect(edit.body.code).toBe("SLOT_CANCELLED");
  });
});

describe("GET /today-lessons (organisation timezone)", () => {
  it("teacher: own slots today; student: only approved reservations today; admin: 403", async () => {
    const startsAt = new Date(Date.now() + 40 * 60_000);
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), title: "本日の授業" }));
    const r1 = await reserve(ctx, w.student, slot.id);
    await reserve(ctx, w.student2, slot.id);
    await decide(ctx, w.teacher, r1.id, "approve", { expected_version: r1.row_version });

    // "Today" follows the API clock in the organisation timezone.
    ctx.clock.now = new Date(slot.starts_at);
    try {
      const teacher = await call(ctx, w.teacher, "GET", "/today-lessons");
      expect(teacher.status).toBe(200);
      expectContract(teacher, "get", "/today-lessons");
      expect(teacher.body.items.map((s: { id: string }) => s.id)).toContain(slot.id);
      const approved = await call(ctx, w.student, "GET", "/today-lessons");
      const item = approved.body.items.find((s: { id: string }) => s.id === slot.id);
      expect(item.meeting_url).toBe("https://meet.example.invalid/room-1");
      expect(item.my_reservation.status).toBe("approved");
      const pendingStudent = await call(ctx, w.student2, "GET", "/today-lessons");
      expect(pendingStudent.body.items.map((s: { id: string }) => s.id)).not.toContain(slot.id);
      expect((await call(ctx, w.otherTeacher, "GET", "/today-lessons")).body.items.map((s: { id: string }) => s.id)).not.toContain(slot.id);
      expect((await call(ctx, w.admin, "GET", "/today-lessons")).status).toBe(403);

      ctx.clock.now = new Date(new Date(slot.starts_at).getTime() + 2 * 86_400_000);
      expect((await call(ctx, w.teacher, "GET", "/today-lessons")).body.items.map((s: { id: string }) => s.id)).not.toContain(slot.id);
    } finally {
      ctx.clock.now = null;
    }
  });
});

describe("attendance", () => {
  it("roster = approved reservations; records with actor; progress recomputed; out-of-roster 422", async () => {
    const startsAt = new Date(Date.now() + 10 * 60_000);
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { startsAt, endsAt: new Date(startsAt.getTime() + 20 * 60_000), title: "出欠テスト" }));
    const r1 = await reserve(ctx, w.student, slot.id);
    await reserve(ctx, w.student2, slot.id);
    await decide(ctx, w.teacher, r1.id, "approve", { expected_version: r1.row_version });

    const roster = await call(ctx, w.teacher, "GET", `/lesson-slots/${slot.id}/attendance`);
    expect(roster.status).toBe(200);
    expectContract(roster, "get", "/lesson-slots/{id}/attendance");
    expect(roster.body.data.editable).toBe(true);
    expect(roster.body.data.items.map((i: { student_id: string }) => i.student_id)).toEqual([w.org.student.userId]);
    expect(roster.body.data.items[0]).toMatchObject({ reservation_status: "approved", attendance_state: null });

    const notInRoster = await call(ctx, w.teacher, "POST", `/lesson-slots/${slot.id}/attendance`, {
      body: { records: [{ student_id: w.org.student2.userId, state: "present" }] },
    });
    expect(notInRoster.status).toBe(422);
    expectContract(notInRoster, "post", "/lesson-slots/{id}/attendance");
    expect(notInRoster.body.field_errors["records.0.student_id"]).toBe("この授業の承認済み受講者ではありません。");

    const res = await call(ctx, w.teacher, "POST", `/lesson-slots/${slot.id}/attendance`, {
      body: { records: [{ student_id: w.org.student.userId, state: "late", note: "10分遅刻" }] },
    });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/lesson-slots/{id}/attendance");
    expect(res.body.data.records).toEqual([{ student_id: w.org.student.userId, state: "late", note: "10分遅刻" }]);
    const { rows } = await ctx.admin.query("SELECT state, recorded_by, note FROM app.attendance WHERE slot_id = $1", [slot.id]);
    expect(rows).toEqual([{ state: "late", recorded_by: w.org.teacher.userId, note: "10分遅刻" }]);

    const corrected = await call(ctx, w.admin, "POST", `/lesson-slots/${slot.id}/attendance`, { body: { records: [{ student_id: w.org.student.userId, state: "present" }] } });
    expect(corrected.status).toBe(200);
    const after = await call(ctx, w.teacher, "GET", `/lesson-slots/${slot.id}/attendance`);
    expect(after.body.data.items[0]).toMatchObject({ attendance_state: "present", recorded_by_name: w.org.admin.displayName });
    const audit = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE entity_id = $1 AND event_type = 'attendance.recorded' ORDER BY created_at", [slot.id]);
    expect(audit.rows.map((r) => [r.payload.before, r.payload.after])).toEqual([
      [null, "late"],
      ["late", "present"],
    ]);

    const dup = await call(ctx, w.teacher, "POST", `/lesson-slots/${slot.id}/attendance`, {
      body: { records: [{ student_id: w.org.student.userId, state: "present" }, { student_id: w.org.student.userId, state: "absent" }] },
    });
    expect(dup.status).toBe(422);
    expect(dup.body.field_errors["records.1.student_id"]).toContain("複数回");
  });

  it("only the slot's teacher or an admin; not before 30 minutes ahead of the start", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version });
    const early = await call(ctx, w.teacher, "POST", `/lesson-slots/${slot.id}/attendance`, { body: { records: [{ student_id: w.org.student.userId, state: "present" }] } });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("ATTENDANCE_NOT_OPEN");
    expect((await call(ctx, w.teacher, "GET", `/lesson-slots/${slot.id}/attendance`)).body.data.editable).toBe(false);
    expect((await call(ctx, w.otherTeacher, "GET", `/lesson-slots/${slot.id}/attendance`)).status).toBe(404);
    expect((await call(ctx, w.student, "GET", `/lesson-slots/${slot.id}/attendance`)).status).toBe(403);
    const studentWrite = await call(ctx, w.student, "POST", `/lesson-slots/${slot.id}/attendance`, { body: { records: [] } });
    expect(studentWrite.status).toBe(403);
    const empty = await call(ctx, w.teacher, "POST", `/lesson-slots/${slot.id}/attendance`, { body: { records: [] } });
    expect(empty.status).toBe(422);
    expect(empty.body.field_errors.records).toBe("1件以上指定してください。");
  });
});

describe("tenant isolation", () => {
  it("users of another organisation never see this organisation's slots", async () => {
    const otherOrg = await createOrg(ctx.admin);
    const outsider = await createUser(ctx.admin, otherOrg, "teacher");
    await ctx.admin.query("INSERT INTO app.teacher_profiles(org_id, id, teacher_number) VALUES ($1, $2, 'X-1')", [otherOrg, outsider.userId]);
    const caller = await bearerCaller(outsider.userId, otherOrg);
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    expect((await call(ctx, caller, "GET", `/lesson-slots/${slot.id}`)).status).toBe(404);
    expect((await call(ctx, caller, "GET", "/lesson-slots?limit=100")).body.items).toEqual([]);
    expect((await call(ctx, caller, "GET", "/reservations")).body.items).toEqual([]);
  });
});
