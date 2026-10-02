import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, cookieCaller, createTestContext, type TestContext } from "./helpers/app";
import { createClassroom, createUser, seedOrg, type OrgScenario } from "./helpers/fixtures";

let ctx: TestContext;
let org: OrgScenario;
beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
});
afterAll(async () => ctx.close());

async function slotWithReservation(startOffset: string, status: "approved" | "pending", expires = "now() + interval '1 day'") {
  const slot = (
    await ctx.admin.query(
      `INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, title, starts_at, ends_at, capacity, booking_closes_at, state)
       VALUES ($1, $2, $3, '検証授業', now() + $4::interval, now() + $4::interval + interval '1 hour', 5, now() + $4::interval - interval '1 hour', 'open') RETURNING id, starts_at, ends_at`,
      [org.orgId, org.classroomId, org.teacher.userId, startOffset],
    )
  ).rows[0];
  await ctx.admin.query(
    `INSERT INTO app.reservations(org_id, slot_id, student_id, starts_at, ends_at, status, expires_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, ${expires}, gen_random_uuid())`,
    [org.orgId, slot.id, org.student.userId, slot.starts_at, slot.ends_at, status],
  );
}

describe("classroom transfer with reservation history", () => {
  it("allows a transfer when the only approved reservation is in the past, refuses it for a future one", async () => {
    const admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
    const target = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: org.otherTeacher.userId });
    await slotWithReservation("-3 days", "approved");
    await slotWithReservation("-2 days", "pending", "now() - interval '3 days'");
    const before = await call(ctx, admin, "GET", `/students/${org.student.userId}`);
    const ok = await call(ctx, admin, "POST", `/students/${org.student.userId}/transfer`, {
      body: { classroom_id: target, teacher_id: org.otherTeacher.userId, reason: "配属変更", expected_version: before.body.data.row_version },
    });
    expect(ok.status).toBe(200);

    await slotWithReservation("+3 days", "approved");
    const after = await call(ctx, admin, "GET", `/students/${org.student.userId}`);
    const blocked = await call(ctx, admin, "POST", `/students/${org.student.userId}/transfer`, {
      body: { classroom_id: org.classroomId, teacher_id: org.teacher.userId, reason: "再配属", expected_version: after.body.data.row_version },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("ACTIVE_RESERVATIONS");
  });
});

describe("archived classroom", () => {
  it("reports CLASSROOM_ARCHIVED instead of CLASSROOM_FULL", async () => {
    const archived = await createClassroom(ctx.admin, org.orgId, { primaryTeacherId: org.teacher.userId });
    await ctx.admin.query("UPDATE app.classrooms SET archived = true WHERE id = $1", [archived]);
    const u = await createUser(ctx.admin, org.orgId, "student");
    await expect(
      ctx.admin.query(
        `INSERT INTO app.student_profiles(org_id, id, employee_number, department_name, joined_on, classroom_id, teacher_id, training_starts_on, training_due_on)
         VALUES ($1, $2, 'X-ARCH', '開発部', '2026-10-01', $3, $4, '2026-10-01', '2026-12-31')`,
        [org.orgId, u.userId, archived, org.teacher.userId],
      ),
    ).rejects.toThrow(/CLASSROOM_ARCHIVED/);
  });
});
