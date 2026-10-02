/**
 * Access matrix for every admin-area operation: 401 without credentials, 403 for roles that are not allowed,
 * 404 for resources of another organisation, Japanese messages and contract-conformant error bodies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { seedOrg, type OrgScenario } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { createOutbox } from "../helpers/admin-fixtures";

let ctx: TestContext;
let org: OrgScenario;
let other: OrgScenario;
let admin: Caller;
let teacherWeb: Caller;
let student: Caller;
let foreignDeletionRequest: string;
let foreignDelivery: string;

interface Op {
  method: string;
  template: string;
  path: () => string;
  /** Roles allowed besides admin. */
  teacher?: boolean;
  body?: () => unknown;
  ifMatch?: boolean;
}

const OPS: Op[] = [
  { method: "GET", template: "/dashboard", path: () => "/dashboard", teacher: true },
  { method: "GET", template: "/teachers", path: () => "/teachers", teacher: true },
  { method: "POST", template: "/teachers", path: () => "/teachers", body: () => ({}) },
  { method: "GET", template: "/teachers/{id}", path: () => `/teachers/${other.teacher.userId}`, teacher: true },
  { method: "PATCH", template: "/teachers/{id}", path: () => `/teachers/${other.teacher.userId}`, body: () => ({}), ifMatch: true },
  { method: "DELETE", template: "/teachers/{id}", path: () => `/teachers/${other.teacher.userId}`, ifMatch: true },
  { method: "GET", template: "/students", path: () => "/students", teacher: true },
  { method: "POST", template: "/students", path: () => "/students", body: () => ({}) },
  { method: "GET", template: "/students/{id}", path: () => `/students/${other.student.userId}`, teacher: true },
  { method: "PATCH", template: "/students/{id}", path: () => `/students/${other.student.userId}`, body: () => ({}), ifMatch: true },
  { method: "DELETE", template: "/students/{id}", path: () => `/students/${other.student.userId}`, ifMatch: true },
  { method: "POST", template: "/students/{id}/transfer", path: () => `/students/${other.student.userId}/transfer`, body: () => ({}) },
  { method: "GET", template: "/classrooms", path: () => "/classrooms", teacher: true },
  { method: "POST", template: "/classrooms", path: () => "/classrooms", body: () => ({}) },
  { method: "GET", template: "/classrooms/{id}", path: () => `/classrooms/${other.classroomId}`, teacher: true },
  { method: "PATCH", template: "/classrooms/{id}", path: () => `/classrooms/${other.classroomId}`, body: () => ({}), ifMatch: true },
  { method: "DELETE", template: "/classrooms/{id}", path: () => `/classrooms/${other.classroomId}`, ifMatch: true },
  { method: "GET", template: "/classrooms/{id}/students", path: () => `/classrooms/${other.classroomId}/students`, teacher: true },
  { method: "GET", template: "/classrooms/{id}/teachers", path: () => `/classrooms/${other.classroomId}/teachers`, teacher: true },
  { method: "GET", template: "/settings", path: () => "/settings" },
  { method: "PATCH", template: "/settings", path: () => "/settings", body: () => ({}), ifMatch: true },
  { method: "GET", template: "/settings/users", path: () => "/settings/users" },
  { method: "POST", template: "/settings/users/invite", path: () => "/settings/users/invite", body: () => ({}) },
  { method: "POST", template: "/settings/users/{id}/disable", path: () => `/settings/users/${other.student.userId}/disable` },
  { method: "POST", template: "/settings/users/{id}/enable", path: () => `/settings/users/${other.student.userId}/enable` },
  { method: "POST", template: "/settings/users/{id}/resend-invite", path: () => `/settings/users/${other.student.userId}/resend-invite` },
  { method: "GET", template: "/settings/account-deletion-requests", path: () => "/settings/account-deletion-requests" },
  {
    method: "POST",
    template: "/settings/account-deletion-requests/{id}/complete",
    path: () => `/settings/account-deletion-requests/${foreignDeletionRequest}/complete`,
  },
  { method: "GET", template: "/events", path: () => "/events" },
  { method: "GET", template: "/events/deliveries", path: () => "/events/deliveries" },
  { method: "POST", template: "/events/deliveries/{id}/retry", path: () => `/events/deliveries/${foreignDelivery}/retry` },
];

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  other = await seedOrg(ctx.admin);
  admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
  teacherWeb = await cookieCaller(ctx, { userId: org.teacher.userId, orgId: org.orgId, role: "teacher" });
  student = await bearerCaller(org.student.userId, org.orgId);
  const r = await ctx.admin.query("INSERT INTO app.account_deletion_requests(org_id, user_id, state) VALUES ($1, $2, 'requested') RETURNING id", [other.orgId, other.student.userId]);
  foreignDeletionRequest = r.rows[0].id;
  foreignDelivery = await createOutbox(ctx.admin, other.orgId, { state: "failed" });
});
afterAll(async () => ctx.close());

describe("admin-area access matrix", () => {
  for (const op of OPS) {
    const label = `${op.method} ${op.template}`;

    it(`${label}: 401 without credentials`, async () => {
      const res = await call(ctx, null, op.method, op.path(), { body: op.body?.(), ifMatch: op.ifMatch ? 1 : undefined });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
      expect(res.body.message_ja).toBe("ログインが必要です。再度ログインしてください。");
      expectContract(res, op.method, op.template);
    });

    it(`${label}: 403 for students${op.teacher ? "" : " and teachers"}`, async () => {
      const asStudent = await call(ctx, student, op.method, op.path(), { body: op.body?.(), ifMatch: op.ifMatch ? 1 : undefined });
      expect(asStudent.status).toBe(403);
      expect(asStudent.body.code).toBe("FORBIDDEN");
      expectContract(asStudent, op.method, op.template);
      if (!op.teacher) {
        const asTeacher = await call(ctx, teacherWeb, op.method, op.path(), { body: op.body?.(), ifMatch: op.ifMatch ? 1 : undefined });
        expect(asTeacher.status).toBe(403);
        expectContract(asTeacher, op.method, op.template);
      }
    });

    // Write operations with a body are covered with valid bodies in their own test files (validation runs first).
    if (/\{id\}/.test(op.template) && !op.body) {
      it(`${label}: another organisation's resource is 404 for an admin`, async () => {
        const res = await call(ctx, admin, op.method, op.path(), { ifMatch: op.ifMatch ? 1 : undefined });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe("NOT_FOUND");
        expectContract(res, op.method, op.template);
      });
    }
  }

  it("admin accounts must use the Web (bearer admin → ADMIN_USE_WEB)", async () => {
    const bearerAdmin = await bearerCaller(org.admin.userId, org.orgId, { aal: "aal2" });
    const res = await call(ctx, bearerAdmin, "GET", "/teachers");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ADMIN_USE_WEB");
  });

  it("admin web sessions without MFA are blocked from admin APIs", async () => {
    const aal1 = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" }, { aal: "aal1" });
    const res = await call(ctx, aal1, "GET", "/settings");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MFA_REQUIRED");
  });
});
