import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { createStudent, createTeacher, createUser, seedOrg, type OrgScenario } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { RequestDb } from "../../src/db/client";
import type { Actor } from "../../src/context";
import { assertCanDeactivate, lockMembership } from "../../src/domain/admin/accounts";

let ctx: TestContext;
let org: OrgScenario;
let other: OrgScenario;
let admin: Caller;
let teacher: Caller;

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  other = await seedOrg(ctx.admin);
  admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
  teacher = await cookieCaller(ctx, { userId: org.teacher.userId, orgId: org.orgId, role: "teacher" });
});
afterAll(async () => ctx.close());

describe("GET /settings/users", () => {
  it("lists every membership of the organisation with role, state and invitation state", async () => {
    const res = await call(ctx, admin, "GET", "/settings/users");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/settings/users");
    const ids = res.body.items.map((u: any) => u.id);
    expect(ids).toEqual(expect.arrayContaining([org.admin.userId, org.teacher.userId, org.student.userId]));
    expect(ids).not.toContain(other.admin.userId);
    expect(res.body.items.find((u: any) => u.id === org.teacher.userId)).toMatchObject({ role: "teacher", active: true, invitation_state: null });
  });

  it("filters by q, role and status and paginates", async () => {
    const byRole = await call(ctx, admin, "GET", "/settings/users?role=teacher");
    expect(byRole.body.items.every((u: any) => u.role === "teacher")).toBe(true);
    const byQ = await call(ctx, admin, "GET", `/settings/users?q=${encodeURIComponent(org.otherStudent.email)}`);
    expect(byQ.body.items.map((u: any) => u.id)).toEqual([org.otherStudent.userId]);
    const p1 = await call(ctx, admin, "GET", "/settings/users?limit=2");
    expect(p1.body.items).toHaveLength(2);
    const p2 = await call(ctx, admin, "GET", `/settings/users?limit=2&cursor=${p1.body.next_cursor}`);
    expectContract(p2, "get", "/settings/users");
    expect(p2.body.items.map((u: any) => u.id)).not.toContain(p1.body.items[0].id);
    const bad = await call(ctx, admin, "GET", "/settings/users?role=owner");
    expect(bad.status).toBe(422);
    expect((await call(ctx, teacher, "GET", "/settings/users")).status).toBe(403);
    expect((await call(ctx, null, "GET", "/settings/users")).status).toBe(401);
  });
});

describe("POST /settings/users/invite", () => {
  it("invites an administrator through the saga", async () => {
    const email = `new-admin-${Date.now()}@example.invalid`;
    const res = await call(ctx, admin, "POST", "/settings/users/invite", { body: { email, display_name: "新任 管理者", role: "admin" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/settings/users/invite");
    expect(res.body.data.state).toBe("sent");
    const m = await ctx.admin.query("SELECT role, active FROM app.memberships WHERE org_id = $1 AND id = $2", [org.orgId, res.body.data.user_id]);
    expect(m.rows[0]).toEqual({ role: "admin", active: true });
    const list = await call(ctx, admin, "GET", "/settings/users?role=admin");
    expect(list.body.items.find((u: any) => u.id === res.body.data.user_id).invitation_state).toBe("sent");
  });

  it("directs teacher/student invitations to the profile forms (422)", async () => {
    const res = await call(ctx, admin, "POST", "/settings/users/invite", { body: { email: `t-${Date.now()}@example.invalid`, display_name: "講師", role: "teacher" } });
    expect(res.status).toBe(422);
    expect(res.body.field_errors.role).toContain("講師管理");
    expectContract(res, "post", "/settings/users/invite");
    const s = await call(ctx, admin, "POST", "/settings/users/invite", { body: { email: `s-${Date.now()}@example.invalid`, display_name: "受講者", role: "student" } });
    expect(s.body.field_errors.role).toContain("新入社員管理");
  });

  it("rejects duplicates, invalid input and non-admins", async () => {
    const dup = await call(ctx, admin, "POST", "/settings/users/invite", { body: { email: org.teacher.email, display_name: "重複", role: "admin" } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("EMAIL_TAKEN");
    const invalid = await call(ctx, admin, "POST", "/settings/users/invite", { body: { email: "x", display_name: "", role: "owner" } });
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.field_errors).sort()).toEqual(["display_name", "email", "role"]);
    expect((await call(ctx, teacher, "POST", "/settings/users/invite", { body: { email: "a@example.invalid", display_name: "a", role: "admin" } })).status).toBe(403);
  });
});

describe("POST /settings/users/{id}/resend-invite", () => {
  it("resends for accounts without a job and is idempotent per key; only the newest link works", async () => {
    const u = await createTeacher(ctx.admin, org.orgId);
    const key = crypto.randomUUID();
    const sentBefore = ctx.auth.invitesSent.length;
    const res = await call(ctx, admin, "POST", `/settings/users/${u.userId}/resend-invite`, { idempotencyKey: key });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/settings/users/{id}/resend-invite");
    expect(res.body.data.invitation.state).toBe("sent");
    const replay = await call(ctx, admin, "POST", `/settings/users/${u.userId}/resend-invite`, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(ctx.auth.invitesSent.length).toBe(sentBefore + 1);
    const firstLink = ctx.mailer.lastLink(u.email);
    const again = await call(ctx, admin, "POST", `/settings/users/${u.userId}/resend-invite`);
    expect(again.status).toBe(200);
    expect(ctx.auth.invitesSent.length).toBe(sentBefore + 2);
    const secondLink = ctx.mailer.lastLink(u.email);
    expect(secondLink?.type).toBe("invite");
    expect(secondLink?.token).not.toBe(firstLink?.token);
    const stale = await call(ctx, null, "POST", "/auth/password", { body: { token: firstLink?.token, password: "Welcome2026a" } });
    expect(stale.status).toBe(401);
    const used = await call(ctx, null, "POST", "/auth/password", { body: { token: secondLink?.token, password: "Welcome2026a" } });
    expect(used.status).toBe(200);
    // After the password is set the person is registered: a further invitation is refused.
    const registered = await call(ctx, admin, "POST", `/settings/users/${u.userId}/resend-invite`);
    expect(registered.status).toBe(409);
    expect(registered.body.message_ja).toContain("既に登録");
  });

  it("records a failed resend as 送信失敗（再送可能）", async () => {
    const u = await createTeacher(ctx.admin, org.orgId);
    ctx.auth.failNextInvite = true;
    const res = await call(ctx, admin, "POST", `/settings/users/${u.userId}/resend-invite`);
    expect(res.status).toBe(200);
    expect(res.body.data.invitation).toMatchObject({ state: "failed" });
    const list = await call(ctx, admin, "GET", "/settings/users?status=invite_failed");
    expect(list.body.items.map((x: any) => x.id)).toContain(u.userId);
  });

  it("refuses disabled accounts, other organisations and non-admins", async () => {
    const u = await createUser(ctx.admin, org.orgId, "admin", { active: false });
    const disabled = await call(ctx, admin, "POST", `/settings/users/${u.userId}/resend-invite`);
    expect(disabled.status).toBe(409);
    expect(disabled.body.message_ja).toContain("停止中");
    expect((await call(ctx, admin, "POST", `/settings/users/${other.teacher.userId}/resend-invite`)).status).toBe(404);
    expect((await call(ctx, teacher, "POST", `/settings/users/${org.student.userId}/resend-invite`)).status).toBe(403);
    expect((await call(ctx, admin, "POST", `/settings/users/${org.student.userId}/resend-invite`, { idempotencyKey: false })).status).toBe(400);
  });
});

describe("POST /settings/users/{id}/disable and /enable", () => {
  it("disables (Web and iOS sessions revoked, audited) and re-enables", async () => {
    const s = await createStudent(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId });
    await ctx.auth.register(s.email, "pw", s.userId);
    const bearer = await bearerCaller(s.userId, org.orgId);
    expect((await call(ctx, bearer, "GET", "/me")).status).toBe(200);
    const res = await call(ctx, admin, "POST", `/settings/users/${s.userId}/disable`);
    expect(res.status).toBe(200);
    expectContract(res, "post", "/settings/users/{id}/disable");
    expect(res.body.data).toMatchObject({ active: false, changed: true });
    expect((await call(ctx, bearer, "GET", "/me")).status).toBe(401);
    expect(await ctx.auth.openBearerSessions(s.userId)).toBe(0);
    const signIn = await call(ctx, null, "POST", "/auth/tokens", { body: { email: s.email, password: "pw" } });
    expect(signIn.status).toBe(403);
    expect(signIn.body.code).toBe("ACCOUNT_DISABLED");
    const again = await call(ctx, admin, "POST", `/settings/users/${s.userId}/disable`);
    expect(again.body.data.changed).toBe(false);

    const enable = await call(ctx, admin, "POST", `/settings/users/${s.userId}/enable`);
    expect(enable.status).toBe(200);
    expectContract(enable, "post", "/settings/users/{id}/enable");
    const fresh = await call(ctx, null, "POST", "/auth/tokens", { body: { email: s.email, password: "pw" } });
    expect(fresh.status).toBe(200);
    expect((await call(ctx, null, "GET", "/me", { headers: { Authorization: `Bearer ${fresh.body.data.access_token}` } })).status).toBe(200);
    const audit = await ctx.admin.query("SELECT event_type FROM app.audit_events WHERE entity_id = $1 AND event_type LIKE 'user.%' ORDER BY created_at", [s.userId]);
    expect(audit.rows.map((r) => r.event_type)).toEqual(["user.disabled", "user.enabled"]);
  });

  it("refuses disabling oneself (the acting admin always remains)", async () => {
    const self = await call(ctx, admin, "POST", `/settings/users/${org.admin.userId}/disable`);
    expect(self.status).toBe(409);
    expect(self.body.code).toBe("CANNOT_DISABLE_SELF");
    expect(self.body.message_ja).toBe("自分自身のアカウントは停止できません。");
    expectContract(self, "post", "/settings/users/{id}/disable");
  });

  it("two admins disabling each other concurrently never leaves the organisation without an admin", async () => {
    const o = await seedOrg(ctx.admin);
    const b = await createUser(ctx.admin, o.orgId, "admin");
    const callerA = await cookieCaller(ctx, { userId: o.admin.userId, orgId: o.orgId, role: "admin" });
    const callerB = await cookieCaller(ctx, { userId: b.userId, orgId: o.orgId, role: "admin" });
    const [ra, rb] = await Promise.all([
      call(ctx, callerA, "POST", `/settings/users/${b.userId}/disable`),
      call(ctx, callerB, "POST", `/settings/users/${o.admin.userId}/disable`),
    ]);
    const statuses = [ra.status, rb.status].sort();
    const { rows } = await ctx.admin.query("SELECT count(*)::int AS n FROM app.memberships WHERE org_id = $1 AND role = 'admin' AND active", [o.orgId]);
    expect(rows[0].n).toBe(1);
    // The loser is refused as the last admin (LAST_ADMIN) or, if it authenticated after the winner committed,
    // rejected because its own account/session was just disabled.
    expect(statuses[0]).toBe(200);
    const loser = ra.status === 200 ? rb : ra;
    expect(["LAST_ADMIN", "ACCOUNT_DISABLED", "SESSION_EXPIRED"]).toContain(loser.body.code);
    expectContract(loser, "post", "/settings/users/{id}/disable");
  });

  it("the last-admin guard refuses stopping the only active admin (domain rule)", async () => {
    const o = await seedOrg(ctx.admin);
    // An actor whose own admin membership is no longer active (the state a concurrent loser observes).
    const stale = await createUser(ctx.admin, o.orgId, "admin", { active: false });
    const actor: Actor = { userId: stale.userId, orgId: o.orgId, role: "admin", orgName: "", timezone: "Asia/Tokyo", displayName: "", method: "cookie", sessionHash: null, aal: "aal2" };
    const db = new RequestDb(ctx.deps.connections);
    try {
      await expect(
        db.tx({ orgId: o.orgId, userId: stale.userId }, async (tx) => {
          const target = await lockMembership(tx, o.orgId, o.admin.userId);
          await assertCanDeactivate(tx, actor, target);
        }),
      ).rejects.toMatchObject({ code: "LAST_ADMIN", message_ja: "有効な管理者が1人だけのため停止できません。先に別の管理者を追加してください。" });
    } finally {
      await db.close();
    }
  });

  it("refuses stopping a primary teacher; non-admins and foreign users are rejected", async () => {
    const res = await call(ctx, admin, "POST", `/settings/users/${org.teacher.userId}/disable`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TEACHER_IS_PRIMARY");
    expect((await call(ctx, teacher, "POST", `/settings/users/${org.student.userId}/disable`)).status).toBe(403);
    expect((await call(ctx, admin, "POST", `/settings/users/${other.student.userId}/disable`)).status).toBe(404);
    expect((await call(ctx, admin, "POST", `/settings/users/${other.student.userId}/enable`)).status).toBe(404);
    expect((await call(ctx, null, "POST", `/settings/users/${org.student.userId}/enable`)).status).toBe(401);
  });

  it("keeps sign-in for another organisation where the person is still active", async () => {
    const s = await createStudent(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId });
    await ctx.auth.register(s.email, "pw", s.userId);
    await ctx.admin.query("INSERT INTO app.memberships(org_id, id, role, active) VALUES ($1, $2, 'teacher', true)", [other.orgId, s.userId]);
    const res = await call(ctx, admin, "POST", `/settings/users/${s.userId}/disable`);
    expect(res.status).toBe(200);
    const signIn = await call(ctx, null, "POST", "/auth/tokens", { body: { email: s.email, password: "pw" } });
    expect(signIn.status).toBe(200);
    const auth = { Authorization: `Bearer ${signIn.body.data.access_token}` };
    expect((await call(ctx, null, "GET", "/me", { headers: { ...auth, "X-ARMS-Org": other.orgId } })).status).toBe(200);
    const here = await call(ctx, null, "GET", "/me", { headers: { ...auth, "X-ARMS-Org": org.orgId } });
    expect(here.status).toBe(403);
    expect(here.body.code).toBe("ACCOUNT_DISABLED");
  });
});

describe("account deletion requests", () => {
  it("lists requests and completes one by stopping the account", async () => {
    const s = await createStudent(ctx.admin, org.orgId, { classroomId: org.classroomId, teacherId: org.teacher.userId });
    const bearer = await bearerCaller(s.userId, org.orgId);
    const requested = await call(ctx, bearer, "POST", "/me/account-deletion", { body: { reason: "退職のため" } });
    expect(requested.status).toBe(200);
    const requestId = requested.body.data.request_id;

    const list = await call(ctx, admin, "GET", "/settings/account-deletion-requests?state=requested");
    expect(list.status).toBe(200);
    expectContract(list, "get", "/settings/account-deletion-requests");
    expect(list.body.items.find((r: any) => r.id === requestId)).toMatchObject({ user_id: s.userId, reason: "退職のため", state: "requested", role: "student", user_active: true });

    const done = await call(ctx, admin, "POST", `/settings/account-deletion-requests/${requestId}/complete`);
    expect(done.status).toBe(200);
    expectContract(done, "post", "/settings/account-deletion-requests/{id}/complete");
    expect(done.body.data).toMatchObject({ state: "completed", already_completed: false });
    // Completion stops the account: its iOS session ends at once.
    expect((await call(ctx, bearer, "GET", "/me")).status).toBe(401);
    const again = await call(ctx, admin, "POST", `/settings/account-deletion-requests/${requestId}/complete`);
    expect(again.body.data.already_completed).toBe(true);
    const audit = await ctx.admin.query("SELECT count(*)::int AS n FROM app.audit_events WHERE entity_id = $1 AND event_type = 'account.deletion_completed'", [requestId]);
    expect(audit.rows[0].n).toBe(1);
    const completed = await call(ctx, admin, "GET", "/settings/account-deletion-requests?state=completed");
    expect(completed.body.items.find((r: any) => r.id === requestId).user_active).toBe(false);
  });

  it("enforces roles, scope and validation", async () => {
    expect((await call(ctx, teacher, "GET", "/settings/account-deletion-requests")).status).toBe(403);
    expect((await call(ctx, null, "GET", "/settings/account-deletion-requests")).status).toBe(401);
    const bad = await call(ctx, admin, "GET", "/settings/account-deletion-requests?state=done");
    expect(bad.status).toBe(422);
    expectContract(bad, "get", "/settings/account-deletion-requests");
    const s = await createStudent(ctx.admin, other.orgId, { classroomId: other.classroomId, teacherId: other.teacher.userId });
    const foreign = await ctx.admin.query("INSERT INTO app.account_deletion_requests(org_id, user_id, state) VALUES ($1, $2, 'requested') RETURNING id", [other.orgId, s.userId]);
    const res = await call(ctx, admin, "POST", `/settings/account-deletion-requests/${foreign.rows[0].id}/complete`);
    expect(res.status).toBe(404);
    expect((await call(ctx, teacher, "POST", `/settings/account-deletion-requests/${foreign.rows[0].id}/complete`)).status).toBe(403);
    // An admin's own request cannot be completed by that admin.
    const own = await ctx.admin.query("INSERT INTO app.account_deletion_requests(org_id, user_id, state) VALUES ($1, $2, 'requested') RETURNING id", [org.orgId, org.admin.userId]);
    const self = await call(ctx, admin, "POST", `/settings/account-deletion-requests/${own.rows[0].id}/complete`);
    expect(self.status).toBe(409);
    expect(self.body.code).toBe("CANNOT_DISABLE_SELF");
  });
});

describe("POST /settings/users/{id}/mfa-reset", () => {
  it("removes another administrator's TOTP factor, ends their sessions and audits; they enroll again at sign-in", async () => {
    const other_admin = await createUser(ctx.admin, org.orgId, "admin");
    await ctx.auth.register(other_admin.email, "Admin-pass-2026", other_admin.userId);
    // The other administrator signs in and enrolls an authenticator.
    const login = await call(ctx, null, "POST", "/auth/login", { body: { email: other_admin.email, password: "Admin-pass-2026", selected_role: "admin" } });
    const cookie = /arms_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] as string;
    const web = { Cookie: `arms_session=${cookie}`, "X-CSRF-Token": login.body.data.csrf_token, Origin: "https://arms.test.invalid" };
    const enroll = await call(ctx, null, "POST", "/auth/mfa/enroll", { headers: web });
    const { totpFromUri } = await import("../helpers/auth");
    expect((await call(ctx, null, "POST", "/auth/mfa/verify", { headers: web, body: { code: await totpFromUri(enroll.body.data.uri) } })).status).toBe(200);

    const res = await call(ctx, admin, "POST", `/settings/users/${other_admin.userId}/mfa-reset`);
    expect(res.status).toBe(200);
    expectContract(res, "post", "/settings/users/{id}/mfa-reset");
    expect(res.body.data).toMatchObject({ id: other_admin.userId, had_factor: true });
    expect((await call(ctx, null, "GET", "/auth/session", { headers: { Cookie: `arms_session=${cookie}` } })).status).toBe(401);
    const cred = await ctx.admin.query("SELECT totp_secret_enc, totp_enrolled_at FROM app.user_credentials WHERE user_id = $1", [other_admin.userId]);
    expect(cred.rows[0]).toEqual({ totp_secret_enc: null, totp_enrolled_at: null });
    const audit = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE entity_id = $1 AND event_type = 'auth.mfa_reset'", [other_admin.userId]);
    expect(audit.rows[0].payload).toEqual({ had_factor: true });
    const again = await call(ctx, null, "POST", "/auth/login", { body: { email: other_admin.email, password: "Admin-pass-2026", selected_role: "admin" } });
    expect(again.body.data).toMatchObject({ mfa_required: true, mfa_enrolled: false });
  });

  it("refuses self, non-admin targets, other organisations and non-admin callers", async () => {
    const self = await call(ctx, admin, "POST", `/settings/users/${org.admin.userId}/mfa-reset`);
    expect(self.status).toBe(422);
    expect(self.body.message_ja).toContain("自分自身");
    const notAdmin = await call(ctx, admin, "POST", `/settings/users/${org.teacher.userId}/mfa-reset`);
    expect(notAdmin.status).toBe(422);
    expect((await call(ctx, admin, "POST", `/settings/users/${other.admin.userId}/mfa-reset`)).status).toBe(404);
    expect((await call(ctx, teacher, "POST", `/settings/users/${org.admin.userId}/mfa-reset`)).status).toBe(403);
    const bearerAdmin = await bearerCaller(org.admin.userId, org.orgId);
    expect((await call(ctx, bearerAdmin, "POST", `/settings/users/${org.admin.userId}/mfa-reset`)).body.code).toBe("ADMIN_USE_WEB");
  });
});
