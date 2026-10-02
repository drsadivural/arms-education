import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { seedOrg, type OrgScenario } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { createReservation, createSlot, futureDate } from "../helpers/admin-fixtures";

let ctx: TestContext;
let org: OrgScenario;
let other: OrgScenario;
let admin: Caller;
let teacherWeb: Caller;

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  other = await seedOrg(ctx.admin, { booking_pending_ttl_seconds: 7200 });
  admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
  teacherWeb = await cookieCaller(ctx, { userId: org.teacher.userId, orgId: org.orgId, role: "teacher" });
});
afterAll(async () => ctx.close());

describe("GET /settings", () => {
  it("returns effective settings (stored values or deployment defaults) with row_version and ETag", async () => {
    const res = await call(ctx, admin, "GET", "/settings");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/settings");
    expect(res.body.data).toMatchObject({
      timezone: "Asia/Tokyo",
      booking_cancel_before_seconds: 86400,
      booking_pending_ttl_seconds: 86400,
      require_admin_mfa: true,
      notifications_enabled: true,
      default_theme: "system",
      holidays: [],
      business_hours: { weekdays: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "18:00" },
    });
    expect(res.headers.get("etag")).toBe(`"${res.body.row_version}"`);
  });

  it("is admin only", async () => {
    expect((await call(ctx, teacherWeb, "GET", "/settings")).status).toBe(403);
    expect((await call(ctx, await bearerCaller(org.student.userId, org.orgId), "GET", "/settings")).status).toBe(403);
    expect((await call(ctx, null, "GET", "/settings")).status).toBe(401);
  });
});

describe("PATCH /settings", () => {
  it("saves provided fields only, audits the change and never touches existing reservations", async () => {
    const slot = await createSlot(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId, startsAt: futureDate(5) });
    const expiresAt = futureDate(1);
    const reservation = await createReservation(ctx.admin, org.orgId, { slotId: slot, studentId: org.student.userId, expiresAt });
    const current = await call(ctx, admin, "GET", "/settings");
    const res = await call(ctx, admin, "PATCH", "/settings", {
      ifMatch: current.body.row_version,
      body: {
        organization_name: "株式会社テスト研修",
        booking_pending_ttl_seconds: 3600,
        booking_cancel_before_seconds: 43200,
        holidays: ["2026-12-31", "2026-12-30", "2026-12-31"],
        departments: ["開発部", "営業部", "サポート部"],
        business_hours: { weekdays: [1, 2, 3, 4, 5], start_time: "10:00", end_time: "19:00" },
        default_theme: "dark",
      },
    });
    expect(res.status).toBe(200);
    expectContract(res, "patch", "/settings");
    expect(res.body.data).toMatchObject({
      organization_name: "株式会社テスト研修",
      booking_pending_ttl_seconds: 3600,
      booking_cancel_before_seconds: 43200,
      holidays: ["2026-12-30", "2026-12-31"],
      departments: ["開発部", "営業部", "サポート部"],
      default_theme: "dark",
      voice_daily_quota_seconds: current.body.data.voice_daily_quota_seconds,
    });
    expect(res.body.row_version).toBe(current.body.row_version + 1);
    const stored = await ctx.admin.query("SELECT name, settings FROM app.organizations WHERE id = $1", [org.orgId]);
    expect(stored.rows[0].name).toBe("株式会社テスト研修");
    expect(stored.rows[0].settings.booking_pending_ttl_seconds).toBe(3600);
    const r = await ctx.admin.query("SELECT expires_at FROM app.reservations WHERE id = $1", [reservation]);
    expect(new Date(r.rows[0].expires_at).toISOString()).toBe(expiresAt.toISOString());
    const audit = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE org_id = $1 AND event_type = 'settings.updated'", [org.orgId]);
    expect(audit.rows[0].payload.changes.booking_pending_ttl_seconds).toEqual({ before: 86400, after: 3600 });
    // Other organisations are unaffected.
    const otherOrg = await ctx.admin.query("SELECT settings FROM app.organizations WHERE id = $1", [other.orgId]);
    expect(otherOrg.rows[0].settings.booking_pending_ttl_seconds).toBe(7200);
  });

  it("requires a current If-Match", async () => {
    const current = await call(ctx, admin, "GET", "/settings");
    const stale = await call(ctx, admin, "PATCH", "/settings", { ifMatch: current.body.row_version - 1, body: { organization_name: "古い" } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expectContract(stale, "patch", "/settings");
    const missing = await call(ctx, admin, "PATCH", "/settings", { body: { organization_name: "なし" } });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("IF_MATCH_REQUIRED");
  });

  it("validates with Japanese field errors", async () => {
    const current = await call(ctx, admin, "GET", "/settings");
    const res = await call(ctx, admin, "PATCH", "/settings", {
      ifMatch: current.body.row_version,
      body: {
        organization_name: "",
        voice_max_session_seconds: 10,
        holidays: ["2026-02-30"],
        departments: ["開発部", "開発部"],
        business_hours: { weekdays: [1], start_time: "18:00", end_time: "09:00" },
        unknown: true,
      },
    });
    expect(res.status).toBe(422);
    expectContract(res, "patch", "/settings");
    expect(res.body.field_errors.organization_name).toBe("必須項目です。");
    expect(res.body.field_errors.voice_max_session_seconds).toBe("60以上の値を入力してください。");
    expect(res.body.field_errors["holidays.0"]).toBeTruthy();
    expect(res.body.field_errors.departments).toBe("部署名が重複しています。");
    expect(res.body.field_errors["business_hours.end_time"]).toBe("終了時刻は開始時刻より後にしてください。");
  });

  it("disabling admin MFA is honoured by authentication", async () => {
    const current = await call(ctx, admin, "GET", "/settings");
    const res = await call(ctx, admin, "PATCH", "/settings", { ifMatch: current.body.row_version, body: { organization_name: current.body.data.organization_name, require_admin_mfa: false } });
    expect(res.body.data.require_admin_mfa).toBe(false);
    const aal1Admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" }, { aal: "aal1" });
    expect((await call(ctx, aal1Admin, "GET", "/settings")).status).toBe(200);
  });

  it("is admin only", async () => {
    const res = await call(ctx, teacherWeb, "PATCH", "/settings", { ifMatch: 1, body: { organization_name: "x" } });
    expect(res.status).toBe(403);
    expectContract(res, "patch", "/settings");
  });
});
