import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMonths, zonedDateString, zonedTimeToInstant } from "@arms/contracts";
import { bearerCaller, call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { seedOrg, type OrgScenario } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { completeUnit, createProgramVersion, createReservation, createSlot, enroll } from "../helpers/admin-fixtures";

let ctx: TestContext;
let org: OrgScenario;
let admin: Caller;
let teacher: Caller;
let otherTeacher: Caller;
let student: Caller;

// Fixed clock: 2026-10-02 10:00 JST.
const NOW = new Date("2026-10-02T01:00:00Z");
let todaySlot: string;
let otherTodaySlot: string;
let midnightSlot: string;

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
  teacher = await bearerCaller(org.teacher.userId, org.orgId);
  otherTeacher = await bearerCaller(org.otherTeacher.userId, org.orgId);
  student = await bearerCaller(org.student.userId, org.orgId);

  // Progress: student (A class) 2 units of weight 1; one completed in August, one in October → Aug 50, Oct 100.
  const p = await createProgramVersion(ctx.admin, org.orgId, { weights: [1, 1] });
  const e = await enroll(ctx.admin, org.orgId, org.student.userId, p.versionId, "2026-07-15T00:00:00Z");
  await completeUnit(ctx.admin, org.orgId, e, p.versionId, p.unitIds[0] as string, "2026-08-10T00:00:00Z");
  await completeUnit(ctx.admin, org.orgId, e, p.versionId, p.unitIds[1] as string, "2026-10-01T00:00:00Z");
  // Other student (B class, 営業部): enrolled in September, nothing completed → 0.
  const p2 = await createProgramVersion(ctx.admin, org.orgId, { weights: [2] });
  await enroll(ctx.admin, org.orgId, org.otherStudent.userId, p2.versionId, "2026-09-05T00:00:00Z");

  // Lessons: today 14:00 JST (A class, teacher) and 16:00 JST (B class, other teacher); tomorrow; a cancelled one today.
  todaySlot = await createSlot(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId, startsAt: new Date("2026-10-02T05:00:00Z"), capacity: 3 });
  otherTodaySlot = await createSlot(ctx.admin, org.orgId, { classroomId: org.otherClassroomId, teacherId: org.otherTeacher.userId, startsAt: new Date("2026-10-02T07:00:00Z") });
  midnightSlot = await createSlot(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId, startsAt: new Date("2026-10-02T15:00:00Z") });
  await createSlot(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId, startsAt: new Date("2026-10-02T02:00:00Z"), state: "cancelled" });

  // Reservations on today's slots: pending (valid), pending (hold elapsed), approved.
  const far = new Date("2027-01-01T00:00:00Z");
  await createReservation(ctx.admin, org.orgId, { slotId: todaySlot, studentId: org.student.userId, status: "pending", expiresAt: far });
  await createReservation(ctx.admin, org.orgId, { slotId: todaySlot, studentId: org.student2.userId, status: "approved" });
  await createReservation(ctx.admin, org.orgId, { slotId: otherTodaySlot, studentId: org.otherStudent.userId, status: "pending", expiresAt: far });
  await createReservation(ctx.admin, org.orgId, { slotId: otherTodaySlot, studentId: org.student.userId, status: "pending", expiresAt: new Date("2026-10-02T00:30:00Z") });
  ctx.clock.now = NOW;
});
afterAll(async () => ctx.close());

describe("GET /dashboard", () => {
  it("aggregates the organisation for admins", async () => {
    const res = await call(ctx, admin, "GET", "/dashboard");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/dashboard");
    const d = res.body.data;
    expect(d.student_count).toBe(3);
    // student 100%, other student 0% → 50
    expect(d.average_progress_percent).toBe(50);
    expect(d.pending_reservation_count).toBe(2);
    expect(d.today_lesson_count).toBe(2);
    expect(d.today_lessons.map((l: any) => l.id)).toEqual([todaySlot, otherTodaySlot]);
    const lesson = d.today_lessons[0];
    expect(lesson).toMatchObject({ remaining: 1, pending_count: 1, approved_count: 1, has_meeting_url: true, meeting_url: "https://meet.example.invalid/room", teacher_name: "田中 祥司" });
    expect(d.pending_reservations).toHaveLength(2);
    expect(d.pending_reservations.every((r: any) => r.status === "pending" && r.meeting_url === null)).toBe(true);
    const months = Array.from({ length: 6 }, (_, i) => addMonths("2026-10", i - 5));
    expect(d.progress_trend.map((t: any) => t.month)).toEqual(months);
    // May–Jun: no enrollments; Jul: student 0; Aug: 50; Sep: (50 + 0) / 2 = 25; Oct: (100 + 0) / 2 = 50
    expect(d.progress_trend.map((t: any) => t.percent)).toEqual([null, null, 0, 50, 25, 50]);
  });

  it("applies department and classroom filters", async () => {
    const dept = await call(ctx, admin, "GET", `/dashboard?department=${encodeURIComponent("営業部")}`);
    expect(dept.body.data).toMatchObject({ student_count: 1, average_progress_percent: 0, pending_reservation_count: 1 });
    const cls = await call(ctx, admin, "GET", `/dashboard?classroom_id=${org.classroomId}`);
    expect(cls.body.data).toMatchObject({ student_count: 2, average_progress_percent: 100, pending_reservation_count: 1, today_lesson_count: 1 });
    expectContract(cls, "get", "/dashboard");
    const bad = await call(ctx, admin, "GET", "/dashboard?classroom_id=nope");
    expect(bad.status).toBe(422);
    expectContract(bad, "get", "/dashboard");
  });

  it("limits teachers to their scope (own students, own slots)", async () => {
    const res = await call(ctx, teacher, "GET", "/dashboard");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/dashboard");
    expect(res.body.data).toMatchObject({ student_count: 2, average_progress_percent: 100, pending_reservation_count: 1, today_lesson_count: 1 });
    expect(res.body.data.today_lessons[0].meeting_url).toBe("https://meet.example.invalid/room");
    const other = await call(ctx, otherTeacher, "GET", "/dashboard");
    expect(other.body.data).toMatchObject({ student_count: 1, today_lesson_count: 1, pending_reservation_count: 1 });
    expect(other.body.data.today_lessons[0].id).toBe(otherTodaySlot);
  });

  it("computes 'today' in JST, not UTC", async () => {
    // Bearer caller: a web session's idle timeout would make this test depend on the real clock.
    // 2026-10-02 23:30 JST (14:30Z): today is the 14:00 JST lesson; the 00:00 JST 10/3 slot (15:00Z) is tomorrow.
    ctx.clock.now = zonedTimeToInstant("2026-10-02", "23:30:00");
    expect(zonedDateString(ctx.clock.now)).toBe("2026-10-02");
    const late = await call(ctx, teacher, "GET", "/dashboard");
    expect(late.body.data.today_lessons.map((l: any) => l.id)).toEqual([todaySlot]);
    // 2026-10-03 00:30 JST (15:30Z — still 10/2 in UTC): only the midnight slot is today.
    ctx.clock.now = new Date("2026-10-02T15:30:00Z");
    const next = await call(ctx, teacher, "GET", "/dashboard");
    expect(next.body.data.today_lessons.map((l: any) => l.id)).toEqual([midnightSlot]);
    ctx.clock.now = NOW;
  });

  it("rejects students and anonymous callers", async () => {
    expect((await call(ctx, student, "GET", "/dashboard")).status).toBe(403);
    const anon = await call(ctx, null, "GET", "/dashboard");
    expect(anon.status).toBe(401);
    expectContract(anon, "get", "/dashboard");
  });
});
